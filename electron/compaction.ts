// Compaction: summarize the older half of a session into a single synthetic
// "context recap" message when total context approaches the model's window.
//
// Strategy:
//   - Estimate tokens from char-count (4 chars/token is fine for triage).
//   - When estimated input > COMPACT_TRIGGER_TOKENS, compact.
//   - Keep the last KEEP_RECENT_TURNS verbatim.
//   - Send everything older to Claude with a fixed summarization prompt and
//     replace it with a single user message containing the summary plus a
//     standard preamble so the model knows what it's reading.
//
// We deliberately do NOT touch JSONL on disk — compaction is a runtime
// projection used to keep the live request small. Re-opening a session pulls
// the full history again.

import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import { getApiKey } from './secret';
import { parseExtendedContext } from './anthropic';
import { ephemeralizeMessages } from './ephemeralize';

const CHARS_PER_TOKEN = 4;
const COMPACT_TRIGGER_TOKENS = 180_000;

/**
 * Per-model context-window caps. Used by `preflightCompactIfNeeded` and
 * `isPromptTooLongError` to decide when to shrink before sending or how
 * aggressively to shrink after a 400. The "1m" suffix on the model id
 * (parsed by `parseExtendedContext`) opts into the 1M-token window.
 */
const CONTEXT_CAP_1M = 1_000_000;
const CONTEXT_CAP_DEFAULT = 200_000;

/**
 * Pre-flight safety threshold expressed as a fraction of the model's
 * cap. Set to 95% so we leave headroom for: (a) the system prompt
 * (which `estimateTokens` doesn't see — it only counts messages), (b)
 * char→token estimate noise (real tokenization is not exactly 4
 * chars/token), and (c) the assistant's `max_tokens` reservation that
 * the API counts against the context window. 95% empirically clears
 * those three sources of slack on Opus-4.7 / Sonnet-4.5 without
 * triggering compaction unnecessarily often.
 */
const PREFLIGHT_SAFETY_FRACTION = 0.95;

function modelCap(model: string): number {
  const { want1m } = parseExtendedContext(model);
  return want1m ? CONTEXT_CAP_1M : CONTEXT_CAP_DEFAULT;
}
/**
 * Compaction tail sizing.
 *
 * Definitions:
 *   - "User-initiated turn" = a user message that's a typed prompt, not a
 *     `tool_result`-only message. Marks the start of a new agent task.
 *
 * Strategy:
 *   We always preserve verbatim from the start of the (KEEP_RECENT_USER_TURNS)-th
 *   most recent user-initiated turn, bounded by MIN/MAX. This guarantees the
 *   model always sees the user's current question (and at least one prior turn
 *   for continuity) — never summarized away.
 *
 * Why not a flat message count?
 *   A single user question can spawn 20+ tool calls inside one agent turn. A
 *   flat `slice(-8)` would compact away the user's actual question while
 *   keeping only the tool-call tail. The model then has to ask "what was your
 *   question again?" — exactly the failure mode that motivated this change.
 */
const KEEP_RECENT_USER_TURNS = 2;
const KEEP_RECENT_TURNS_MIN = 8;
const KEEP_RECENT_TURNS_MAX = 60;
const SUMMARIZER_MODEL = 'claude-haiku-4-5';
const SUMMARIZER_MAX_TOKENS = 4096;

function isUserInitiatedTurn(m: Anthropic.MessageParam): boolean {
  if (m.role !== 'user') return false;
  if (typeof m.content === 'string') return true;
  if (!Array.isArray(m.content)) return false;
  // A user-initiated turn never starts with tool_result blocks. (It may still
  // contain attached images or text + tool_result combos in weird sessions,
  // but the simple test "no tool_result blocks" matches what humans type.)
  return (m.content as any[]).every((b) => b?.type !== 'tool_result');
}

/**
 * Pick the start index of the verbatim tail. Walks backwards looking for the
 * (KEEP_RECENT_USER_TURNS)-th most recent user-initiated turn. Falls back to
 * a message-count slice if not enough user-initiated turns exist, and clamps
 * to [MIN, tailMax] message-count bounds for safety.
 *
 * `tailMax` overrides KEEP_RECENT_TURNS_MAX (the default cap of 60). The
 * emergency-recovery path passes a smaller value to force-shrink the tail
 * when normal compaction wasn't enough to clear the cap.
 */
function computeKeepStartIndex(
  messages: Anthropic.MessageParam[],
  tailMax: number = KEEP_RECENT_TURNS_MAX
): number {
  let userTurnsFound = 0;
  let idxAtTargetTurn = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isUserInitiatedTurn(messages[i])) {
      userTurnsFound++;
      if (userTurnsFound >= KEEP_RECENT_USER_TURNS) {
        idxAtTargetTurn = i;
        break;
      }
    }
  }
  let cut =
    idxAtTargetTurn >= 0
      ? idxAtTargetTurn
      : Math.max(0, messages.length - KEEP_RECENT_TURNS_MIN);
  const tailSize = messages.length - cut;
  if (tailSize < KEEP_RECENT_TURNS_MIN) {
    cut = Math.max(0, messages.length - KEEP_RECENT_TURNS_MIN);
  } else if (tailSize > tailMax) {
    cut = messages.length - tailMax;
  }
  return cut;
}

export function estimateTokens(messages: Anthropic.MessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const b of m.content as any[]) {
        if (typeof b?.text === 'string') chars += b.text.length;
        else if (typeof b?.content === 'string') chars += b.content.length;
        else chars += JSON.stringify(b ?? {}).length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Find a "clean" cut index at or before `desiredEnd` such that the head
 * (messages[0..cutIdx)) doesn't end with an unmatched tool_use. This avoids
 * the case where the tail begins with a `tool_result` whose matching
 * `tool_use` got compacted into the summary — the Anthropic API would
 * reject that.
 *
 * We walk backwards from `desiredEnd` looking for a boundary where:
 *   - the message at index cutIdx-1 (last message in head) is NOT an
 *     assistant message ending in unmatched tool_use blocks, AND
 *   - the message at index cutIdx (first message in tail) is NOT a user
 *     message whose first non-text block is a tool_result.
 *
 * In practice, walking backwards by 1 each step usually finds a safe spot
 * within 1-3 messages because tool turns are bounded.
 */
function findSafeCutIndex(
  messages: Anthropic.MessageParam[],
  desiredEnd: number
): number {
  // Build a map from tool_use_id -> the message index that contains the result.
  const resultByUseId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === 'tool_result' && b.tool_use_id) {
        resultByUseId.set(b.tool_use_id, i);
      }
    }
  }

  // Walk backwards from desiredEnd searching for a safe boundary. A safe
  // boundary is one where neither side has unpaired tool blocks crossing it.
  for (let cut = desiredEnd; cut >= 1; cut--) {
    const headLast = messages[cut - 1];
    const tailFirst = messages[cut];

    // (1) Reject cuts where the tail's first message starts with a
    //     tool_result. (Compaction summary sits before; orphan would result.)
    if (tailFirst && tailFirst.role === 'user' && Array.isArray(tailFirst.content)) {
      const firstBlock = (tailFirst.content as any[])[0];
      if (firstBlock?.type === 'tool_result') continue;
    }

    // (2) Reject cuts where the head's last message has tool_use blocks
    //     whose tool_results live AFTER the cut (those results would be on
    //     the tail side, but the tool_use is being summarized away).
    if (
      headLast &&
      headLast.role === 'assistant' &&
      Array.isArray(headLast.content)
    ) {
      let hasOrphanedToolUse = false;
      for (const b of headLast.content as any[]) {
        if (b?.type === 'tool_use' && b.id) {
          const resultIdx = resultByUseId.get(b.id);
          // resultIdx >= cut means the result is in the tail (orphaned head).
          // resultIdx === undefined means there's no result anywhere (unrelated
          // problem; sanitization handles it). Either way we shouldn't cut here.
          if (resultIdx === undefined || resultIdx >= cut) {
            hasOrphanedToolUse = true;
            break;
          }
        }
      }
      if (hasOrphanedToolUse) continue;
    }

    return cut;
  }

  // Couldn't find a safe boundary at all. Fall back to keeping everything as
  // tail (no compaction). Better to OOM-on-context than corrupt the request.
  return 0;
}

/**
 * Options for `maybeCompact` to override its trigger / tail-size limits.
 *
 * Used by `preflightCompactIfNeeded` (which forces a compaction at our
 * 95% safety threshold) and `emergencyCompact` (which always compacts
 * AND tightens the verbatim tail) so we don't have to re-implement the
 * core compaction flow in three places.
 */
export interface CompactOpts {
  /**
   * Override the default 180K trigger. Set to `1` to force compaction
   * regardless of estimated size.
   */
  triggerTokens?: number;
  /**
   * Override the default 60-message verbatim tail cap. Tightening this
   * during emergency recovery is what actually reduces the payload —
   * the head summary is fixed-size, so the tail is the only knob.
   */
  keepRecentTurnsMax?: number;
}

/**
 * Returns a possibly-compacted copy of `messages`. If under the trigger, the
 * input is returned as-is. Otherwise calls a cheap summarizer model and
 * replaces the older slice with one synthetic user message.
 */
export async function maybeCompact(
  messages: Anthropic.MessageParam[],
  opts?: CompactOpts
): Promise<Anthropic.MessageParam[]> {
  const trigger = opts?.triggerTokens ?? COMPACT_TRIGGER_TOKENS;
  const tailMax = opts?.keepRecentTurnsMax ?? KEEP_RECENT_TURNS_MAX;
  const tokens = estimateTokens(messages);
  if (tokens < trigger) return messages;
  if (messages.length <= KEEP_RECENT_TURNS_MIN + 2) return messages;

  // Pick the verbatim-tail start by preserving the last N user-initiated
  // turns (so the model always sees the user's current question and one
  // prior turn for continuity), then nudge to the nearest safe cut so we
  // don't split a tool_use/tool_result pair. `tailMax` lets the caller
  // shrink the tail further than the default during emergency recovery.
  const desiredCut = computeKeepStartIndex(messages, tailMax);
  const safeCut = findSafeCutIndex(messages, desiredCut);
  if (safeCut === 0) {
    log.warn(
      '[compaction] no safe cut found; skipping compaction to avoid breaking tool pairing'
    );
    return messages;
  }

  const tail = messages.slice(safeCut);
  const head = messages.slice(0, safeCut);

  log.info(
    `[compaction] triggered: ~${tokens} tokens, compacting first ${head.length} msgs, keeping last ${tail.length}`
  );

  const summary = await summarize(head).catch((e) => {
    log.error('[compaction] summarizer failed, falling back to head-truncate', e);
    return null;
  });

  if (!summary) {
    // Fallback: keep only the tail and a placeholder so the agent doesn't
    // pretend to remember things it just lost.
    return [
      {
        role: 'user',
        content: `[Older conversation history elided (~${tokens} tokens). No summary available — be cautious about claims that require older context.]`,
      } as Anthropic.MessageParam,
      ...tail,
    ];
  }

  return [
    {
      role: 'user',
      content: [
        `[Context recap — earlier ${head.length} messages from this session, compacted to save tokens.]`,
        ``,
        summary,
        ``,
        `[End of recap. The messages below are verbatim and continue from where the recap left off.]`,
      ].join('\n'),
    } as Anthropic.MessageParam,
    ...tail,
  ];
}

/**
 * Pattern-match the Anthropic API's "prompt too long" 400 error.
 *
 * The SDK surfaces this as an `Anthropic.APIError` (or sometimes a
 * plain Error from the SSE transport) with a message like:
 *   `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1008265 tokens > 1000000 maximum"},"request_id":"req_..."}`
 *
 * We detect by the literal "prompt is too long" string because the
 * SDK's typed error fields (`status`, `error.type`) aren't always
 * populated when the failure happens during streaming. Returns the
 * estimated input token count from the error message when parseable
 * (handy for logging "we were 8K over"), or 0 when not.
 */
export function isPromptTooLongError(e: unknown): { hit: boolean; tokens: number } {
  if (!e) return { hit: false, tokens: 0 };
  const message = (e as any)?.message ?? String(e);
  const text = typeof message === 'string' ? message : '';
  if (!text.includes('prompt is too long')) return { hit: false, tokens: 0 };
  const m = text.match(/(\d{4,})\s*tokens?\s*>\s*\d+/);
  const tokens = m ? Number(m[1]) : 0;
  return { hit: true, tokens };
}

/**
 * Pre-flight: if estimated tokens exceed the safety threshold for the
 * model's context window, compact in place. Returns the (possibly
 * compacted) message array.
 *
 * This is the proactive guard. It fires before we hit the cap so the
 * vast majority of long sessions never see a 400. The reactive
 * `emergencyCompact` is the fallback for cases this misses (e.g. the
 * estimate was off because of attachment base64 or a pile of tool_use
 * blocks the estimator under-counts).
 */
export async function preflightCompactIfNeeded(
  messages: Anthropic.MessageParam[],
  model: string
): Promise<Anthropic.MessageParam[]> {
  const cap = modelCap(model);
  const safety = Math.floor(cap * PREFLIGHT_SAFETY_FRACTION);
  const tokens = estimateTokens(messages);
  if (tokens < safety) return messages;
  log.info(
    `[compaction] preflight: estimated ${tokens} tokens >= safety ${safety} (cap ${cap}); compacting`
  );
  return await maybeCompact(messages, { triggerTokens: 1 });
}

/**
 * Emergency: aggressively shrink the message array. Called after we
 * actually hit a "prompt is too long" 400 from the API.
 *
 * Two-stage strategy (each stage handles a different failure mode):
 *
 *  1. **Ephemeralize tool_results.** A single huge tool_result (e.g. a
 *     Read of a multi-MB file, a Bash output with millions of chars,
 *     a screenshot) can blow the cap by itself even when message
 *     count is small. `ephemeralizeMessages` truncates anything > 32KB
 *     to a deterministic synopsis like
 *     `[Read#3 8.4MB ref:tr_a1b2c3d4] (first non-empty line)`,
 *     surfacing enough that the model can choose to re-read if it
 *     genuinely needs the data.
 *
 *  2. **Aggressive head compaction.** Bypass the trigger (always
 *     compact), tighten KEEP_RECENT_TURNS_MAX so even a small head
 *     gets a tighter tail. If the summarizer itself fails we still
 *     return a truncated array (not the original) — leaving the
 *     original means the retry will 400 again.
 *
 * The two stages are independent: ephemeralization can fix the
 * "one fat tool_result" case without compaction firing, and vice
 * versa. We run both because we don't know which one is the cause —
 * we just hit a 400 and need to shrink something.
 */
export async function emergencyCompact(
  messages: Anthropic.MessageParam[]
): Promise<Anthropic.MessageParam[]> {
  if (messages.length === 0) return messages;
  const beforeTokens = estimateTokens(messages);
  log.warn(
    `[compaction] emergency: bypass trigger, ephemeralize+aggressive-tail (${messages.length} msgs, ~${beforeTokens} tokens in)`
  );

  // Stage 1: ephemeralize. Cheap (no API call) — pure local string
  // truncation. Often resolves the entire problem when the cause was
  // one outlier tool_result, in which case compaction is a no-op.
  const ephemeralized = ephemeralizeMessages(messages);
  const afterEphemTokens = estimateTokens(ephemeralized);
  log.info(
    `[compaction] emergency stage 1 (ephemeralize): ~${beforeTokens} → ~${afterEphemTokens} tokens`
  );

  // Stage 2: aggressive head compaction. If ephemeralization already
  // got us comfortably under, compaction may also no-op (which is
  // fine — the override trigger=1 still calls maybeCompact, which
  // skips when messages.length is too short to safely cut).
  return await maybeCompact(ephemeralized, {
    triggerTokens: 1,
    keepRecentTurnsMax: Math.min(KEEP_RECENT_TURNS_MAX, 20),
  });
}

async function summarize(messages: Anthropic.MessageParam[]): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    log.warn('[compaction] no API key, skipping summarization');
    return null;
  }
  const client = new Anthropic({ apiKey });

  const systemText = [
    `You are a session compaction agent. Summarize the conversation provided as input.`,
    ``,
    `Goals:`,
    `  1. Preserve every concrete decision, change, file edit, command result, and unresolved question.`,
    `  2. Drop chatter, false starts, and re-readings of the same code.`,
    `  3. Use bullet structure with sub-bullets per area of work. Reference file paths, function names, and key values verbatim — don't paraphrase identifiers.`,
    `  4. End with an "Open threads" section listing anything in-flight or pending.`,
    `  5. Write for an agent that will pick up the work in the next turn, not for a human reader.`,
    ``,
    `Length budget: aim for the smallest summary that loses nothing actionable. 1500 tokens max.`,
  ].join('\n');

  // Inline the older conversation as a single user message so it's all in one
  // place. Strip tool_use/tool_result internals down to their text for the
  // summarizer — it doesn't need to round-trip schemas, just understand what
  // happened.
  const conversation = messages
    .map((m, i) => {
      const role = m.role;
      const text = renderForSummarizer(m);
      return `--- msg ${i} [${role}] ---\n${text}`;
    })
    .join('\n\n');

  const resp = await client.messages.create({
    model: SUMMARIZER_MODEL,
    max_tokens: SUMMARIZER_MAX_TOKENS,
    system: systemText,
    messages: [{ role: 'user', content: conversation }],
  });
  const out = resp.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
  return out || null;
}

function renderForSummarizer(m: Anthropic.MessageParam): string {
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  const out: string[] = [];
  for (const b of m.content as any[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push(b.text);
    } else if (b.type === 'tool_use') {
      out.push(
        `[tool_use ${b.name}] ${JSON.stringify(b.input ?? {}).slice(0, 1200)}`
      );
    } else if (b.type === 'tool_result') {
      const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      out.push(
        `[tool_result${b.is_error ? ' ERROR' : ''}] ${content.slice(0, 1200)}`
      );
    }
  }
  return out.join('\n');
}
