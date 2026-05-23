// Agent turn loop: send user message → stream response → execute tools →
// loop until model ends turn or calls WaitForUser. Persists every event to
// our own JSONL (mirrors Claude Code's format for interop) and inserts a
// usage_event into SQLite for cost tracking.

import { BrowserWindow } from 'electron';
import log from 'electron-log';
import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import {
  buildSystemBlocks,
  streamMessage,
  withConversationCacheBreakpoint,
  DEFAULT_MODEL,
} from './anthropic';
import {
  appendJsonlEvent,
  ensureOurPathSeeded,
  loadMessagesFromJsonl,
  ourJsonlPath,
  platformShortName,
  sanitizeMessages,
} from './sessionRuntime';
import {
  executeTool,
  getToolSchemas,
  isWaitForUser,
  TOOLS,
} from './tools';
import {
  insertAuditEvent,
  insertUsageEvent,
  setSessionState,
  setSessionPending,
  getSessionPending,
  getSessionApiKey,
  upsertSession,
  getSetting,
} from './db';
import { getDefaultApiKeyId } from './secret';
import { computeCostMicros } from './pricing';
import { loadMemory } from './memory';
import { precheckCall } from './budget';
import { broadcastAgentEvent, broadcastStateChanged } from './agentEvents';
// Note: client-side `ephemeralizeMessages` and `maybeCompact` are no
// longer called from the agent loop — `streamMessage` now relies on
// Anthropic's server-side `clear_tool_uses_20250919` to micro-compact
// older tool results. The source files remain in the codebase as a
// fallback for future use (e.g. legacy models without context-management
// support). See `electron/anthropic.ts:streamMessage`.

export type AgentEvent =
  | { type: 'turn_start'; sessionId: string; userText: string }
  | { type: 'text_delta'; sessionId: string; text: string }
  | { type: 'tool_use_start'; sessionId: string; id: string; name: string }
  | { type: 'tool_use_input_delta'; sessionId: string; id: string; partial: string }
  | { type: 'tool_use_done'; sessionId: string; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      sessionId: string;
      id: string;
      content: string;
      isError: boolean;
      ms: number;
    }
  | { type: 'usage'; sessionId: string; costUsdMicros: number; usage: any }
  | {
      type: 'wait_for_user';
      sessionId: string;
      id: string;
      question: string;
    }
  | { type: 'turn_done'; sessionId: string; stopReason: string | null }
  | {
      /**
       * The agent loop drained a user-typed-while-running interrupt off the
       * queue and is about to inject it into the next user message. The
       * renderer mirrors this as a user bubble so the typed text appears in
       * the visual transcript at the moment it actually entered the
       * conversation, not retroactively.
       */
      type: 'interrupt_picked_up';
      sessionId: string;
      text: string;
    }
  | { type: 'state_changed'; sessionId: string; state: string }
  | {
      type: 'budget_blocked';
      sessionId: string;
      reason: string;
      capMicros: number;
      spentMicros: number;
    }
  /**
   * Visibility into the gap between "tool finished" and "model started
   * responding". With huge contexts (700K+ tokens) the API's time-to-
   * first-token can be 10-60 seconds, during which NOTHING streams. The
   * UI was previously silent during this entire wait, leaving the user
   * with the false impression the agent was hung. We emit
   * `awaiting_response` right before every `streamMessage` call (with a
   * rough input-token estimate so the user understands WHY it's slow),
   * and `response_started` when the first content event arrives (so the
   * UI can clear the "thinking..." indicator).
   */
  | {
      type: 'awaiting_response';
      sessionId: string;
      estimatedInputTokens: number;
      messageCount: number;
    }
  | { type: 'response_started'; sessionId: string; latencyMs: number }
  | { type: 'error'; sessionId: string; message: string };

const activeRuns = new Map<string, AbortController>();

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 4096 ? s.slice(0, 4096) + '…' : s;
  } catch {
    return String(v);
  }
}

export function isRunning(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

/**
 * Cancel an in-flight turn. Aborts the AbortController so the Anthropic
 * stream and any signal-aware tools (SHELL, GREP, WaitFor*) tear down. A
 * watchdog forcibly cleans up `activeRuns` if the run is still mapped
 * after a grace period — defense in depth against any future tool that
 * forgets to honor the signal. Without this, a hung tool wedges the
 * session in "running" forever and no further messages can be sent.
 */
export function cancelRun(sessionId: string) {
  const ctrl = activeRuns.get(sessionId);
  if (!ctrl) return;
  ctrl.abort();
  setTimeout(() => {
    if (activeRuns.has(sessionId)) {
      log.warn(
        `[agent] cancelRun watchdog: ${sessionId} still active 5s after abort, force-cleaning`
      );
      activeRuns.delete(sessionId);
      try {
        setSessionState(sessionId, 'idle');
        broadcastStateChanged(sessionId, 'idle');
      } catch (e) {
        log.warn('[agent] watchdog state reset failed', e);
      }
      // Broadcast a turn_done so the UI's streaming spinner clears even
      // when the agent loop is wedged on an unresponsive tool. Any
      // orphaned tool Promise that eventually resolves will land on a
      // dead session and its output will be discarded — that's
      // acceptable; the user already chose to bail.
      broadcastAgentEvent({ type: 'turn_done', sessionId, stopReason: 'force-aborted' });
    }
  }, 5000).unref();
}

/**
 * Per-session queue of text the user typed while a turn was already running.
 * Drained between tool rounds: the next user message that carries tool_results
 * also gets a trailing text block with everything the user has typed since the
 * last drain, so the model sees the new context immediately without losing
 * the in-flight tool round-trip.
 *
 * Keys are session IDs; values are arrays of FIFO text snippets. We never grow
 * unbounded — when a turn ends without draining (e.g. errored), the queue is
 * still readable so the next `runUserTurn` can pick it up.
 */
const _pendingInterrupts = new Map<string, string[]>();

/** Push an interrupt onto the session's queue. Returns the new queue size. */
export function queueInterrupt(sessionId: string, text: string): number {
  const t = text.trim();
  if (!t) return _pendingInterrupts.get(sessionId)?.length ?? 0;
  const cur = _pendingInterrupts.get(sessionId) ?? [];
  cur.push(t);
  _pendingInterrupts.set(sessionId, cur);
  log.info(`[agent] queued interrupt for ${sessionId} (${cur.length} pending)`);
  return cur.length;
}

/** Read-and-clear the queue for a session. Returns the snippets in FIFO order. */
function drainInterrupts(sessionId: string): string[] {
  const cur = _pendingInterrupts.get(sessionId);
  if (!cur || cur.length === 0) return [];
  _pendingInterrupts.delete(sessionId);
  return cur;
}

export function peekInterrupts(sessionId: string): number {
  return _pendingInterrupts.get(sessionId)?.length ?? 0;
}

/**
 * Remove a single occurrence of `text` from the queue. Used when the user
 * clicks "×" on a queued bubble before the agent has picked it up. We
 * match by exact (post-trim) text — if the user queued two identical
 * messages, this removes one. Returns true if a removal happened.
 */
export function removeInterrupt(sessionId: string, text: string): boolean {
  const cur = _pendingInterrupts.get(sessionId);
  if (!cur || cur.length === 0) return false;
  const t = text.trim();
  const idx = cur.indexOf(t);
  if (idx < 0) return false;
  cur.splice(idx, 1);
  if (cur.length === 0) _pendingInterrupts.delete(sessionId);
  log.info(`[agent] removed queued interrupt for ${sessionId} (${cur.length} remain)`);
  return true;
}

/**
 * Renderer-side attachment shape, mirrored from `src/types.ts`. We accept
 * untyped `unknown[]` over IPC and validate here so a malformed payload can't
 * crash the main process or send malformed content blocks to Anthropic.
 */
type IncomingAttachment =
  | {
      kind: 'image';
      name?: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      dataBase64: string;
    }
  | { kind: 'pdf'; name?: string; dataBase64: string }
  | { kind: 'text'; name?: string; text: string };

interface RunArgs {
  sessionId: string;
  projectId: string;
  cwd: string;
  userText: string;
  attachments?: unknown[];
  /** History to seed if our JSONL is empty. Used when continuing imported sessions. */
  seedFromJsonl?: string | null;
  /**
   * When true, treat this call as a CONTINUATION of an in-flight turn
   * that was paused mid-flight by the per-call budget governor. Skips
   * appending a new user message — the JSONL already has everything
   * the loop needs, including the original user prompt and any
   * intermediate assistant / tool_result rounds. `userText` should be
   * empty in this mode; if it's not, it's still appended as an
   * additional follow-up. The resume sweep sets this when waking a
   * session whose `pending_user_text` is empty (meaning the pause
   * happened between API calls, not before the user message landed).
   */
  continueExisting?: boolean;
}

/** Type guard: is this a valid image media type for Anthropic? */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
function isImageMediaType(s: unknown): s is ImageMediaType {
  return typeof s === 'string' && (IMAGE_MEDIA_TYPES as readonly string[]).includes(s);
}

/**
 * Validate + normalize the renderer-supplied attachments array. Drops any
 * entries we can't safely encode into Anthropic content blocks (e.g. missing
 * data, wrong media type) rather than failing the whole turn.
 */
function normalizeAttachments(raw: unknown[] | undefined): IncomingAttachment[] {
  if (!raw || !Array.isArray(raw)) return [];
  const out: IncomingAttachment[] = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    if (
      r.kind === 'image' &&
      typeof r.dataBase64 === 'string' &&
      isImageMediaType(r.mediaType)
    ) {
      out.push({
        kind: 'image',
        name: typeof r.name === 'string' ? r.name : undefined,
        mediaType: r.mediaType,
        dataBase64: r.dataBase64,
      });
    } else if (r.kind === 'pdf' && typeof r.dataBase64 === 'string') {
      out.push({
        kind: 'pdf',
        name: typeof r.name === 'string' ? r.name : undefined,
        dataBase64: r.dataBase64,
      });
    } else if (r.kind === 'text' && typeof r.text === 'string') {
      out.push({
        kind: 'text',
        name: typeof r.name === 'string' ? r.name : undefined,
        text: r.text,
      });
    }
  }
  return out;
}

/**
 * Build the Anthropic content array for a user turn out of free-form text +
 * structured attachments. Order: leading text (if any), images, PDFs, then
 * any inlined plain-text attachments. Keeping text first matches Anthropic's
 * recommendation and means the system can apply caching to the prefix.
 *
 * Returns `unknown` because the stable SDK's `MessageParam.content` array type
 * doesn't yet include the `document` (PDF) variant, even though the runtime
 * API accepts it. We cast at the streamMessage boundary.
 */
function buildUserContent(text: string, attachments: IncomingAttachment[]): unknown {
  // No attachments → keep the simple string form for back-compat (matches
  // what the JSONL has historically stored for plain user turns).
  if (attachments.length === 0) return text;

  const blocks: unknown[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const a of attachments) {
    if (a.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType, data: a.dataBase64 },
      });
    } else if (a.kind === 'pdf') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: a.dataBase64 },
      });
    } else if (a.kind === 'text') {
      // Inline as a labeled text block; cheaper than wrapping in a separate
      // document block and the model treats it the same way.
      blocks.push({
        type: 'text',
        text: `\n\n--- Attached: ${a.name ?? 'file'} ---\n${a.text}\n--- end ${a.name ?? 'file'} ---`,
      });
    }
  }
  if (blocks.length === 0) return text;
  return blocks;
}

function broadcast(e: AgentEvent) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('agent:event', e);
  }
}

/**
 * Run a single user message through the agent loop. Resolves once the loop
 * exits (turn_done or wait_for_user). Multiple tool-use sub-turns happen
 * inside this one call; each contributes a usage_event row.
 */
export async function runUserTurn(args: RunArgs): Promise<void> {
  const { sessionId, projectId, cwd, userText, seedFromJsonl } = args;
  const attachments = normalizeAttachments(args.attachments);
  if (activeRuns.has(sessionId)) {
    log.warn(`[agent] turn already running for ${sessionId}; ignoring`);
    return;
  }
  const ctrl = new AbortController();
  activeRuns.set(sessionId, ctrl);

  const onEv = (e: AgentEvent) => broadcast(e);

  // Resolve which API key this session is using. `getSessionApiKey` returns
  // the session's persisted api_key_id, or null if the user never set one
  // (most existing sessions, especially imported ones). In the null case we
  // resolve to the current default at turn-start time — which means
  // promoting a different key to default mid-conversation will move all
  // null-binding sessions onto it transparently. Sessions with an explicit
  // api_key_id stay pinned. The budget governor and Anthropic client both
  // accept null and re-resolve to the current default internally, so this
  // double-lookup is mostly a defensive belt-and-suspenders.
  const resolvedApiKeyId: string | null =
    getSessionApiKey(sessionId) ?? getDefaultApiKeyId();

  try {
    // ---- Pre-turn budget pre-flight ------------------------------------
    //
    // This is the FIRST of two checkpoints. It fires once, BEFORE we
    // touch the JSONL or push the user message into `messages`. If the
    // bucket is already exhausted at turn start (and the session has
    // already used its min-one-call exemption this hour) we park the
    // user's text in `pending_user_text` and sleep the session right
    // here — the message goes nowhere until the resume sweep wakes us.
    //
    // The SECOND checkpoint lives inside the while loop below and fires
    // before every subsequent `streamMessage`. The two-checkpoint
    // design exists because the pre-turn case has a user message we
    // need to STASH (not lose), while the in-loop case can rely on the
    // JSONL already being the source of truth (the user message is
    // written, intermediate rounds are written; resume just continues
    // the loop).
    //
    // Continuation mode (resume sweep set `continueExisting: true`)
    // skips this pre-turn check entirely. The session was already
    // mid-flight; the resume sweep already decided the bucket has room.
    if (!args.continueExisting) {
      const budget = precheckCall(sessionId, resolvedApiKeyId);
      if (!budget.allowed) {
        // Park the user's intent so the resume sweep can auto-fire at
        // the top of the next hour. Without this, the message would be
        // lost on app restart or when the renderer state evicts the chat.
        //
        // APPEND instead of overwrite: if the user already has a queued
        // message (typed a thought, hit send, got blocked, then typed
        // another thought and hit send), we keep BOTH. Without this,
        // each subsequent send-while-sleeping silently destroyed the
        // prior queued reply — the user's first thought was lost the
        // moment they typed a second.
        const prev = getSessionPending(sessionId)?.pending_user_text ?? null;
        const merged = prev && prev.trim()
          ? `${prev.trim()}\n\n${userText.trim()}`
          : userText;
        setSessionPending(sessionId, merged, Date.now());
        setSessionState(sessionId, 'sleeping-budget');
        broadcastStateChanged(sessionId, 'sleeping-budget');
        onEv({
          type: 'budget_blocked',
          sessionId,
          reason: budget.reason,
          capMicros: budget.capMicros,
          spentMicros: budget.spentMicros,
        });
        onEv({ type: 'turn_done', sessionId, stopReason: 'budget' });
        return;
      }
      // We're either fresh or auto-resumed; clear any stale pending marker.
      setSessionPending(sessionId, null, null);
    }

    setSessionState(sessionId, 'running');
    broadcastStateChanged(sessionId, 'running');
    onEv({ type: 'turn_start', sessionId, userText });

    const ourPath = ourJsonlPath(sessionId);

    // For imported Claude Code sessions, copy the imported history into
    // ourPath on first use (and repair already-broken sessions where new
    // events were appended without the seed prefix). After this call,
    // ourPath is the single source of truth for both the agent loop and
    // the UI loader. Idempotent — safe to call every turn.
    ensureOurPathSeeded(ourPath, seedFromJsonl);

    // Load existing history. ourPath is now canonical; the legacy "fall back
    // to seed" branch is kept as a defensive backstop in case seeding failed
    // (e.g. disk full, permissions).
    let messages: Anthropic.MessageParam[] = loadMessagesFromJsonl(ourPath);
    if (messages.length === 0 && seedFromJsonl) {
      messages = loadMessagesFromJsonl(seedFromJsonl);
    }

    // Drain any leftover interrupts (text the user queued during a previous
    // turn that never got picked up — e.g. the prior turn ended without
    // hitting a tool-result iteration). Prepend their text to this turn's
    // user message so they're not lost. Emit `interrupt_picked_up` events so
    // the renderer can promote any optimistic pending bubbles into real
    // messages and clear the "queued" indicator.
    const startupInterrupts = drainInterrupts(sessionId);
    for (const t of startupInterrupts) {
      onEv({ type: 'interrupt_picked_up', sessionId, text: t });
    }
    const effectiveText =
      startupInterrupts.length > 0
        ? `${startupInterrupts.join('\n\n')}${userText ? `\n\n${userText}` : ''}`
        : userText;

    // Append user message. If the renderer attached images / PDFs / inline
    // text files, build a content-block array; otherwise keep the historical
    // plain-string form (cheaper to log, identical semantics to the model).
    // The cast to MessageParam is safe at runtime — the SDK's content array
    // type is missing the `document` variant, but Anthropic's API accepts it.
    //
    // SKIPPED in continuation mode (resume sweep waking a mid-flight pause):
    // the user message is already in JSONL from the original turn, and the
    // loaded `messages` already contains it plus any intermediate
    // assistant/tool_result rounds. We re-enter the loop with what's there.
    // If the caller passed BOTH `continueExisting` AND non-empty `userText`
    // (or attachments), we treat the new text as a follow-up appended on
    // top of the existing history — same semantics as a fresh send while
    // the session was running.
    if (!args.continueExisting || effectiveText.trim() || attachments.length > 0) {
      const userContent = buildUserContent(effectiveText, attachments);
      const userMsg = {
        role: 'user' as const,
        content: userContent,
      } as Anthropic.MessageParam;
      messages.push(userMsg);
      appendJsonlEvent(ourPath, {
        type: 'user',
        uuid: randomUUID(),
        sessionId,
        cwd,
        message: { role: 'user', content: userContent },
      });
    } else {
      log.info(
        `[agent] continueExisting=true; skipping user-message append (messages=${messages.length})`
      );
    }

    const model = (getSetting('model') as string) || DEFAULT_MODEL;
    const memory = loadMemory({ cwd, projectId });
    if (memory.sources.length > 0) {
      log.info(
        `[agent] loaded memory: ${memory.sources.length} files, ${memory.text.length}b (truncated ${memory.truncatedBytes}b)`
      );
    }
    const systemBlocks = buildSystemBlocks({
      sessionId,
      cwd,
      date: new Date(),
      platform: platformShortName(),
      memoryText: memory.text,
      // Anchor the user's prompt as a system-level "current task" reminder
      // so the model never loses track of what it's working on, even after
      // many tool rounds where compaction may have summarized away the
      // original message. See `currentTask` doc in buildSystemBlocks for
      // why this exists.
      currentTask: userText,
    });
    const tools = getToolSchemas();


    // ---- Monitoring-bail runtime guardrail -----------------------------
    //
    // The model is repeatedly violating the system-prompt instruction to
    // call WaitForTime when it wants to "keep monitoring". Symptom: a
    // training/build/process babysitting turn ends with text like
    // "Train at 1h41min — likely on binary RF #3. Process alive.
    // Continuing to monitor." and NO tool call — so the runtime puts
    // the session into waiting-on-user and the human has to babysit
    // the agent that was supposed to babysit the work.
    //
    // Guardrail: when a turn iteration ends with text containing
    // monitoring-bail language AND no tool calls were issued THIS
    // iteration, inject a strong synthetic user message instructing
    // the model to call WaitForTime / WaitForFile / WaitForProcess /
    // WaitForHttp and continue. Bounded by MAX_MONITORING_NUDGES so a
    // genuinely confused model doesn't get pummeled forever (it'll
    // eventually fall through to the normal waiting-on-user
    // disposition if it can't comply, surfacing the bug to the user).
    let monitoringNudgesUsed = 0;
    // Bumped from 2 → 4 because the model often invents elaborate
    // bail-out phrasings ("/loop fires", "cron will pick up next",
    // "armed monitoring loop") that take more than one round of
    // nudging to fully unlearn within a single session. 4 still
    // bounds the worst case so a genuinely confused model doesn't
    // get pummeled forever.
    const MAX_MONITORING_NUDGES = 4;

    // ----- Context shaping is now SERVER-SIDE -----------------------------
    //
    // Anthropic's `context_management` beta does what `maybeCompact` and
    // `ephemeralizeMessages` were doing client-side, but better:
    //   - clear_tool_uses_20250919 micro-compacts older tool results in
    //     place as we approach the trigger threshold (150K for 200K
    //     models, 600K for 1M).
    //   - It runs SERVER-SIDE so we don't pay a Haiku summarizer round-
    //     trip per turn, AND it doesn't bust our prompt cache.
    //   - We send the unmodified message history; the server handles
    //     curation transparently.
    //
    // Result: long-running turns no longer eat 5-30s of overhead per
    // round, and big-bang summarizations (which used to lose the goal
    // when they failed on huge imported sessions) are replaced by
    // continuous micro-compaction that keeps recent context fresh.
    //
    // The legacy client-side compaction code is left in the codebase
    // (`maybeCompact`, `ephemeralizeMessages`, `estimateTokens`) but no
    // longer called from the agent loop — see `electron/anthropic.ts`
    // `streamMessage` for the new server-side wiring.
    //
    // Pass the current tool registry to sanitize so it can drop tool_use
    // blocks that reference tools no longer available — most commonly an
    // imported Claude Code session referenced an MCP server keyed by a
    // UUID that doesn't exist in the current Guy Code MCP registry. The
    // API rejects messages whose tool_use names don't match the active
    // tools list, so we strip those blocks (and their tool_results) from
    // history before sending.
    const knownToolNames = new Set(tools.map((t) => t.name));
    messages = sanitizeMessages(messages, knownToolNames);

    // Loop: send → handle tools → repeat
    let stopReason: string | null = null;
    while (true) {
      // Bail BEFORE the next API call if the user already cancelled
      // during a tool exec. Without this, every cancel-during-tool
      // costs one extra round-trip to Anthropic that immediately
      // throws AbortError — wasted tokens and a noisy error path.
      if (ctrl.signal.aborted) {
        log.info(`[agent] aborted ${sessionId} (between tool round and next stream)`);
        onEv({ type: 'turn_done', sessionId, stopReason: 'aborted' });
        break;
      }

      // ---- Per-API-call budget pre-flight ------------------------------
      //
      // The second of two budget checkpoints (the first is the pre-turn
      // one above). This fires before EVERY `streamMessage` — every loop
      // iteration, including iterations triggered by tool_result rounds.
      // A long turn that makes 50 API calls goes through this gate 50
      // times. No reservations, no in-flight counter: per-call gating
      // means the worst-case drift between two parallel sessions on the
      // same key is one extra call's spend, and the carry-over math
      // absorbs that into the next hour's effective cap.
      //
      // On block: persist the session as `sleeping-budget` and return.
      // We do NOT touch `pending_user_text` here because the original
      // user message is already in JSONL along with any intermediate
      // rounds we've completed. The resume sweep will see an empty
      // pending text + sleeping-budget state and call back into this
      // function with `continueExisting: true` to re-enter the loop
      // without injecting a new user message.
      {
        const budget = precheckCall(sessionId, resolvedApiKeyId);
        if (!budget.allowed) {
          log.info(
            `[agent] per-call budget block ${sessionId}: ${budget.reason}`
          );
          setSessionState(sessionId, 'sleeping-budget');
          broadcastStateChanged(sessionId, 'sleeping-budget');
          onEv({
            type: 'budget_blocked',
            sessionId,
            reason: budget.reason,
            capMicros: budget.capMicros,
            spentMicros: budget.spentMicros,
          });
          onEv({ type: 'turn_done', sessionId, stopReason: 'budget' });
          return;
        }
      }

      // Stream a single message
      const partials = new Map<number, { id: string; name: string; input: string }>();
      let pendingText = '';

      // Per-iteration: only sanitize (defensive backstop for tool pairing
      // and unknown-tool filtering). Ephemeralize/compact are gone —
      // server handles them now.
      const sanitized = sanitizeMessages(messages, knownToolNames);
      const messagesToSend = withConversationCacheBreakpoint(sanitized);

      // Surface the API call to the UI so the "thinking..." gap is visible.
      // Estimate input tokens from JSON character count (~4 chars/token is
      // the standard rule of thumb for English; tool_results pad it but
      // it's good enough for "is this 50K or 700K"). We measure on the
      // serialized payload because that's what the API actually counts.
      let estTokens = 0;
      try {
        estTokens = Math.round(JSON.stringify(messagesToSend).length / 4);
      } catch {
        estTokens = 0;
      }
      const apiStartedAt = Date.now();
      let firstEventAt = 0;
      log.info(
        `[agent] api call start sessionId=${sessionId} messages=${messagesToSend.length} estInputTokens=${estTokens}`
      );
      onEv({
        type: 'awaiting_response',
        sessionId,
        estimatedInputTokens: estTokens,
        messageCount: messagesToSend.length,
      });

      const response = await streamMessage({
        model,
        system: systemBlocks,
        tools,
        messages: messagesToSend,
        signal: ctrl.signal,
        apiKeyId: resolvedApiKeyId,
        onEvent: (sev) => {
          // First server event of this round → time-to-first-token
          // landmark. Fire `response_started` exactly once so the UI
          // can swap the "thinking..." indicator for live streaming.
          if (firstEventAt === 0) {
            firstEventAt = Date.now();
            const latencyMs = firstEventAt - apiStartedAt;
            log.info(
              `[agent] api first event sessionId=${sessionId} ttft=${latencyMs}ms`
            );
            onEv({ type: 'response_started', sessionId, latencyMs });
          }
          if (sev.type === 'content_block_start') {
            const block = sev.content_block;
            if (block.type === 'tool_use') {
              partials.set(sev.index, { id: block.id, name: block.name, input: '' });
              onEv({
                type: 'tool_use_start',
                sessionId,
                id: block.id,
                name: block.name,
              });
            } else if (block.type === 'text') {
              // nothing yet
            }
          } else if (sev.type === 'content_block_delta') {
            if (sev.delta.type === 'text_delta') {
              pendingText += sev.delta.text;
              onEv({
                type: 'text_delta',
                sessionId,
                text: sev.delta.text,
              });
            } else if (sev.delta.type === 'input_json_delta') {
              const p = partials.get(sev.index);
              if (p) {
                p.input += sev.delta.partial_json;
                onEv({
                  type: 'tool_use_input_delta',
                  sessionId,
                  id: p.id,
                  partial: sev.delta.partial_json,
                });
              }
            }
          } else if (sev.type === 'content_block_stop') {
            // Tool input is fully streamed — parse the accumulated JSON
            // once and surface a `tool_use_done` event with the
            // structured input. The renderer uses this to (a) clear the
            // tool_use block's `partialInput` for clean display, and
            // (b) update the persistent CurrentPlan panel for tools
            // like TodoWrite without waiting on the assistant message
            // to be appended.
            const p = partials.get(sev.index);
            if (p) {
              let parsed: unknown = {};
              try {
                parsed = p.input ? JSON.parse(p.input) : {};
              } catch (parseErr) {
                log.warn(
                  `[agent] tool_use input JSON parse failed for ${p.name} (${p.id}): ${(parseErr as Error).message}`
                );
                parsed = {};
              }
              onEv({
                type: 'tool_use_done',
                sessionId,
                id: p.id,
                name: p.name,
                input: parsed,
              });
              partials.delete(sev.index);
            }
          }
        },
      });

      // Round complete — log timing so the user can see in the console
      // whether slowness was server-side TTFT, generation, or tool work.
      const apiTotalMs = Date.now() - apiStartedAt;
      const ttftMs = firstEventAt > 0 ? firstEventAt - apiStartedAt : -1;
      const generationMs = firstEventAt > 0 ? Date.now() - firstEventAt : -1;
      log.info(
        `[agent] api call done sessionId=${sessionId} total=${apiTotalMs}ms ttft=${ttftMs}ms gen=${generationMs}ms inputTokens=${(response.usage as any)?.input_tokens ?? '?'} cacheReadTokens=${(response.usage as any)?.cache_read_input_tokens ?? '?'} outputTokens=${(response.usage as any)?.output_tokens ?? '?'}`
      );

      stopReason = response.stop_reason;

      // Persist assistant message + usage
      appendJsonlEvent(ourPath, {
        type: 'assistant',
        uuid: response.id,
        sessionId,
        cwd,
        message: {
          role: 'assistant',
          model: response.model,
          content: response.content,
          usage: response.usage,
          stop_reason: response.stop_reason,
        },
      });

      // Cost accounting
      const u = response.usage as any;
      const inputTokens = u.input_tokens ?? 0;
      const cacheReadTokens = u.cache_read_input_tokens ?? 0;
      const cacheCreate1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const cacheCreate5m =
        u.cache_creation?.ephemeral_5m_input_tokens ??
        Math.max(0, (u.cache_creation_input_tokens ?? 0) - cacheCreate1h);
      const outputTokens = u.output_tokens ?? 0;
      const costUsdMicros = computeCostMicros(response.model, {
        inputTokens,
        cacheReadTokens,
        cacheWrite5mTokens: cacheCreate5m,
        cacheWrite1hTokens: cacheCreate1h,
        outputTokens,
      });
      insertUsageEvent({
        ts: Date.now(),
        projectId,
        sessionId,
        turnId: response.id,
        model: response.model,
        inputTokens,
        cacheReadTokens,
        cacheWrite5mTokens: cacheCreate5m,
        cacheWrite1hTokens: cacheCreate1h,
        outputTokens,
        costUsdMicros,
        source: 'live',
        apiKeyId: resolvedApiKeyId,
      });
      onEv({
        type: 'usage',
        sessionId,
        costUsdMicros,
        usage: response.usage,
      });

      // Append assistant to messages
      messages.push({ role: 'assistant', content: response.content });

      // Check for tool_use blocks
      const toolUses = response.content.filter(
        (b: any) => b.type === 'tool_use'
      ) as Anthropic.ToolUseBlock[];

      if (toolUses.length === 0) {
        // Monitoring-bail guardrail: scan the assistant's last text for
        // patterns that strongly imply "I'm going to keep monitoring
        // asynchronously" — e.g. "Continuing to monitor", "Will check
        // back at...", "Sleeping until...". If we see those AND the
        // model didn't actually call a WaitFor* tool this iteration,
        // the turn would otherwise end with the session going to
        // waiting-on-user — which is the exact bug the user reported.
        // Inject a synthetic user message telling the model to call
        // WaitForTime NOW and continue the loop, and re-run instead
        // of breaking.
        if (monitoringNudgesUsed < MAX_MONITORING_NUDGES) {
          const lastText = response.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
            .toLowerCase();
          // Tight patterns to avoid false positives. Each must clearly
          // indicate "I'm about to bail out of work that should keep
          // running". Things like "I'll let you know when this is
          // done" qualify; bland completion text like "Done." doesn't.
          //
          // The model has been shown to compress its monitoring-bail
          // language into terser forms ("Continuing." / "Standing by.")
          // that miss the longer phrases. To catch those without false-
          // positiving the same words used mid-sentence, the bare-word
          // patterns are anchored to end-of-text — "the build is
          // continuing as planned, all green" stays clean, but
          // "Train at 2h14min … Continuing." trips the guard.
          const MONITORING_PATTERNS: RegExp[] = [
            /\bcontinuing to monitor\b/,
            /\bcontinue to monitor\b/,
            /\bkeep(ing)? monitoring\b/,
            /\bi'?ll (keep monitoring|monitor|check (back|in|on|at)|report (back|when)|notify|let you know (when|once)|update you|wait|resume|come back|continue)\b/,
            /\bwill (keep monitoring|monitor|check (back|in|on|at)|report (back|when)|notify|let you know (when|once)|update you|continue)\b/,
            /\bsleeping (until|for|now)\b/,
            /\bnext check (at|in)\b/,
            /\bwaking (up|back) (at|in)\b/,
            /\bresuming (at|in)\b/,
            /\bpausing (until|for)\b/,
            /\bmonitoring (this|the|continues|in progress|every|the (process|build|training|run|job|pipeline|deployment))\b/,
            // Bare end-of-text "Continuing." / "Standing by." / etc.
            // These are short hand-off-without-tool phrases the model
            // uses after reporting a status snapshot. End-anchor avoids
            // matching the same word inside a fuller sentence.
            /\b(continuing|continued|standing by|holding (pattern|steady)|will update|updating soon|awaiting (completion|next check)?|more to come|more soon|next update|in progress|underway|ongoing)\.?\s*$/,
            // "Still running" / "Still monitoring" — declarative status
            // with no action.
            /\bstill (monitoring|running|going|watching|working|checking|waiting|in progress)\b/,
            // Pure status snapshot at end of message with no follow-up
            // action. Patterns like "Train at 2h14min", "Build at 90%",
            // "Process up 1h2m" — the model is reporting progress on a
            // long-running thing without taking the next action. If we
            // matched a follow-up tool call, we wouldn't be in this
            // branch; the snapshot-only end of turn is the bail.
            /\b(train|training|build|run|job|process|deployment|pipeline)\s+(at|past|after|on)\s+\S*\d\S*(min|h|s|%|step|iter)/,
            // /loop hallucination — the model imports a Claude Code
            // concept that doesn't exist here. Any reference to a
            // "/loop" firing, scheduled cron, scheduled task, or
            // armed timer/loop/monitor as a passive resumption
            // mechanism is a bail. Guy Code has NO out-of-turn
            // scheduler — the only way to monitor over time is a
            // WaitFor* tool call in the same turn.
            /\/loop\b/,
            /\b(armed|set up|set|scheduled|configured) (a |an |the )?(cron|loop|monitor|timer|scheduled task|scheduled job|background (job|task|monitor|loop))\b/,
            /\b(cron|scheduled (task|job)|background (job|task)) (will |should |is going to )?(fire|fires|trigger|triggers|pick (it|this) up|run|wake|resume)\b/,
            /\b(next|first|upcoming) (fire|trigger|tick|wake|run|sweep|cycle|iteration|check-?in)\b/,
            /\bwait(ing)? for (the )?(\/loop|cron|scheduler|sweep|tick)\b/,
          ];
          const looksMonitoring = MONITORING_PATTERNS.some((re) => re.test(lastText));
          if (looksMonitoring) {
            monitoringNudgesUsed++;
            const nudgeText =
              'SYSTEM GUARDRAIL — your reply contained monitoring-bail language ' +
              "(e.g. \"continuing to monitor\", \"will check back\", \"i'll let you know\", " +
              '"/loop fires", "cron will pick up", "armed monitoring loop") ' +
              'but you did NOT call WaitForTime, WaitForFile, WaitForProcess, or WaitForHttp ' +
              'this iteration. Ending the turn here puts the session into waiting-on-user and ' +
              'breaks the user — they expected you to do the monitoring autonomously without ' +
              'their attention.\n\n' +
              'CRITICAL — there is NO out-of-turn scheduler in Guy Code. There is NO "/loop", ' +
              'no cron-as-resumer, no scheduled task that wakes you up. Even if you set up an ' +
              'OS-level cron job earlier in this turn, that cron only writes to files on disk ' +
              "— it does NOT resume your turn. The ONLY way to monitor over time is a WaitFor* " +
              'tool call in this same turn that suspends-and-wakes the agent loop.\n\n' +
              'Required action RIGHT NOW: call WaitForTime(ms) with the duration you implied ' +
              '(e.g. WaitForTime(1800000) for 30 minutes), or WaitForProcess(pid, timeoutMs) ' +
              'if you have a process handle, or WaitForFile/WaitForHttp for the appropriate ' +
              'completion condition. After the wait returns, take the next monitoring action ' +
              '(Bash to read logs / curl / ps / etc.) and continue the loop.\n\n' +
              'Do NOT respond with more text first. Do NOT explain why. Just call the tool. ' +
              "If you've actually been told to stop monitoring (the user said so explicitly), " +
              'call WaitForUser with a question confirming that — never end a monitoring turn ' +
              'with bare text. ' +
              (monitoringNudgesUsed === MAX_MONITORING_NUDGES
                ? '(This is your LAST guardrail nudge — the next text-only end-of-turn will be accepted as a real stop, even if it still contains monitoring language.)'
                : `(Guardrail nudges used: ${monitoringNudgesUsed} / ${MAX_MONITORING_NUDGES}.)`);
            messages.push({
              role: 'user' as const,
              content: nudgeText,
            } as Anthropic.MessageParam);
            appendJsonlEvent(ourPath, {
              type: 'user',
              uuid: randomUUID(),
              sessionId,
              cwd,
              message: { role: 'user', content: nudgeText },
            });
            log.warn(
              `[agent] monitoring-bail detected for ${sessionId}; injecting nudge (${monitoringNudgesUsed}/${MAX_MONITORING_NUDGES})`
            );
            // Re-loop without breaking — next iteration will re-stream
            // with the nudge in the conversation history.
            continue;
          }
        }
        // No more tools — turn is done. We deliberately go to
        // `waiting-on-user` here (NOT idle) so the session keeps
        // surfacing in the user's "needs you" group. Policy: only the
        // user transitions a session to idle, by explicitly archiving
        // it from the UI. This prevents the failure mode where the
        // model says "I'll keep monitoring every 30 minutes" and then
        // the runtime drops the session into idle, where the user
        // loses track of work that was supposed to continue.
        //
        // Emit a synthetic `wait_for_user` so the UI's awareness of
        // "this session needs me" is consistent whether the model
        // called WaitForUser explicitly or just finished a text-only
        // response. The question is left empty — the UI shows a
        // simple "needs you" pill in that case.
        setSessionState(sessionId, 'waiting-on-user');
        broadcastStateChanged(sessionId, 'waiting-on-user');
        onEv({
          type: 'wait_for_user',
          sessionId,
          id: 'turn-end',
          question: '',
        });
        onEv({ type: 'turn_done', sessionId, stopReason });
        break;
      }

      // Execute each tool. WaitForUser short-circuits the loop.
      // We also short-circuit if the user typed something between rounds
      // (an interrupt arrived in the queue) — running more tool calls when
      // the human has new input to deliver wastes their wall-clock time
      // and risks spending tokens on a direction they're trying to redirect.
      const toolResultBlocks: any[] = [];
      let waitedForUser = false;
      for (let toolIdx = 0; toolIdx < toolUses.length; toolIdx++) {
        const tu = toolUses[toolIdx];
        // Before each tool run (except the first), check the interrupt queue.
        // If non-empty, synthesize "(skipped — user interrupted)" results for
        // the rest so the conversation history stays well-formed (every
        // tool_use needs a tool_result), then break out of the loop.
        if (toolIdx > 0 && peekInterrupts(sessionId) > 0) {
          for (let j = toolIdx; j < toolUses.length; j++) {
            const skip = toolUses[j];
            if (isWaitForUser(skip.name)) continue; // handle below if first
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: skip.id,
              content: '(skipped — user provided new input mid-turn; reconsider before re-running)',
            });
            // Also surface in the UI as a "result" so the spinner stops
            // and the card shows it was skipped.
            onEv({
              type: 'tool_result',
              sessionId,
              id: skip.id,
              content: '(skipped — user interrupted)',
              isError: false,
              ms: 0,
            });
          }
          log.info(
            `[agent] interrupt detected mid-tool-batch; skipped ${toolUses.length - toolIdx} pending tool(s)`
          );
          break;
        }
        if (isWaitForUser(tu.name)) {
          const question = String((tu.input as any)?.question ?? '');
          // Synthesize a tool_result so the conversation history is well-formed
          // when the user's reply comes back.
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: '(waiting on user)',
          });
          setSessionState(sessionId, 'waiting-on-user');
          broadcastStateChanged(sessionId, 'waiting-on-user');
          onEv({
            type: 'wait_for_user',
            sessionId,
            id: tu.id,
            question,
          });
          waitedForUser = true;
          // Don't execute remaining tools after WaitForUser; the user's reply
          // is what the model will see next.
          break;
        }

        const start = Date.now();
        const { content, isError } = await executeTool(tu.name, tu.input, {
          sessionId,
          cwd,
          projectId,
          memory,
          signal: ctrl.signal,
          // Forward the resolved api key so subagent tools (Task / Plan /
          // Execute / Review) charge their child calls to the same key
          // and budget bucket the parent is using.
          apiKeyId: resolvedApiKeyId,
        });
        const ms = Date.now() - start;
        // Audit row for this tool call. Output is summarized to keep DB
        // small; full content lives in the JSONL.
        try {
          insertAuditEvent({
            ts: start,
            projectId,
            sessionId,
            tool: tu.name,
            inputJson: safeStringify(tu.input),
            outputRef: content.length > 256 ? content.slice(0, 256) + '…' : content,
            status: isError ? 'error' : 'ok',
            durationMs: ms,
          });
        } catch (e) {
          log.warn('[agent] audit insert failed', e);
        }
        // Tool may have flipped state to waiting-on-system mid-execution
        // (e.g. WaitFor*); reset to running for the next iteration.
        setSessionState(sessionId, 'running');
        broadcastStateChanged(sessionId, 'running');
        onEv({
          type: 'tool_result',
          sessionId,
          id: tu.id,
          content,
          isError,
          ms,
        });
        const block: any = {
          type: 'tool_result',
          tool_use_id: tu.id,
          content,
        };
        if (isError) block.is_error = true;
        toolResultBlocks.push(block);
      }

      // ---- Mid-turn interruption pickup ----------------------------------
      // If the user typed something while we were running tools, append their
      // text as additional blocks on the SAME user message that carries the
      // tool_results. Anthropic's API allows mixed user content (tool_results
      // + text), so this is the cleanest way to inject the new context: the
      // next assistant streamMessage sees both the tool output AND the user's
      // new instruction in one logical user turn.
      const interrupts = drainInterrupts(sessionId);
      const userBlocks: any[] = [...toolResultBlocks];
      if (interrupts.length > 0) {
        // Concatenate snippets; FIFO order means earlier interrupts appear
        // first, which is what users expect when they typed multiple lines.
        const noteText =
          interrupts.length === 1
            ? `[user added while tools ran]\n${interrupts[0]}`
            : `[user added while tools ran — ${interrupts.length} messages]\n` +
              interrupts.map((t, i) => `(${i + 1}) ${t}`).join('\n\n');
        userBlocks.push({ type: 'text', text: noteText });
        log.info(
          `[agent] picked up ${interrupts.length} interrupt(s) for ${sessionId}`
        );
        // Mirror them in the chat as if they were normal user messages so the
        // user sees their own input immediately — without this they'd vanish
        // into the next API call with no visual record.
        for (const t of interrupts) {
          onEv({ type: 'interrupt_picked_up', sessionId, text: t });
        }
      }

      // Persist + queue as a user message
      const trUserMsg: Anthropic.MessageParam = {
        role: 'user',
        content: userBlocks as any,
      };
      messages.push(trUserMsg);
      appendJsonlEvent(ourPath, {
        type: 'user',
        uuid: randomUUID(),
        sessionId,
        cwd,
        message: { role: 'user', content: userBlocks },
      });

      if (waitedForUser) {
        onEv({ type: 'turn_done', sessionId, stopReason: 'wait_for_user' });
        break;
      }
      // Continue loop — next iteration sends the assistant follow-up
    }

    // Update session row mtime / preview etc by re-upserting last preview.
    // The session row's last_message_preview gets refreshed on next listAll.
    upsertSession({
      id: sessionId,
      projectId,
      jsonlPath: ourJsonlPath(sessionId),
      jsonlMtime: Date.now(),
      jsonlSize: 0,
      startedAt: Date.now(),
      endedAt: Date.now(),
      messageCount: messages.length,
      lastMessagePreview: userText.slice(0, 200),
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      log.info(`[agent] aborted ${sessionId}`);
      onEv({ type: 'turn_done', sessionId, stopReason: 'aborted' });
    } else {
      log.error('[agent] error', e);
      setSessionState(sessionId, 'error');
      broadcastStateChanged(sessionId, 'error');
      onEv({
        type: 'error',
        sessionId,
        message: e?.message ?? String(e),
      });
    }
  } finally {
    activeRuns.delete(sessionId);
    // The old reservation-based governor used to decrement an in-flight
    // counter here. Removed in the carry-over rewrite: per-call
    // precheck makes that race-protection unnecessary because the
    // worst-case drift between two parallel sessions on the same key
    // is one extra call's spend, and the carry-over math absorbs it
    // into the next hour's effective cap automatically.
  }
}
