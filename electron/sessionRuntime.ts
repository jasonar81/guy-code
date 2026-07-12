// Session runtime: per-session JSONL on disk + helpers for loading message
// history into a form the Anthropic SDK accepts.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';
import type Anthropic from '@anthropic-ai/sdk';

export interface SessionRuntimeMeta {
  sessionId: string;
  projectId: string;
  cwd: string;
  jsonlPath: string;
  createdAt: number;
}

export function sessionsRoot(): string {
  const dir = join(app.getPath('home'), '.guycode', 'sessions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ourJsonlPath(sessionId: string): string {
  return join(sessionsRoot(), `${sessionId}.jsonl`);
}

/** Append a JSONL event to a session log, creating the file if needed. */
export function appendJsonlEvent(jsonlPath: string, event: Record<string, unknown>) {
  const line = JSON.stringify({ ...event, timestamp: new Date().toISOString() }) + '\n';
  appendFileSync(jsonlPath, line, 'utf8');
}

/**
 * Sentinel event written at the top of `ourPath` after seeding from an
 * imported file. The loader filters anything that isn't `user`/`assistant`
 * so this is invisible to message-parsing code, but lets us detect "already
 * seeded" on subsequent turns without re-reading the entire seed file.
 */
const SEED_MARKER_TYPE = '_guy_seeded';

/** Read the first `maxBytes` of a file as UTF-8. Used for cheap header checks. */
function readHead(path: string, maxBytes: number): string {
  const stat = statSync(path);
  if (stat.size === 0) return '';
  const fd = openSync(path, 'r');
  try {
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Ensure `ourPath` contains the full history from an imported `seedPath`.
 *
 * Background:
 *   When a user continues an imported Claude Code session, we used to write
 *   new events to `ourPath` (a fresh file in `~/.guycode/sessions/`) without
 *   first copying the imported history into it. The agent loop was happy —
 *   it read the seed for context — but the UI loader, which reads from
 *   `ourPath` whenever it exists, would only see the new events. Result: the
 *   prior conversation appeared to vanish after the first turn.
 *
 * Fix:
 *   - If `ourPath` doesn't exist, write the seed contents into it (preceded
 *     by a sentinel marker so we know it's been seeded).
 *   - If `ourPath` exists but lacks the sentinel AND a seed is available,
 *     this is a previously-broken session: repair it by prepending the seed
 *     contents in front of whatever was already written.
 *   - If the sentinel is present, do nothing.
 *   - If `seedPath` equals `ourPath` (native Guy session), do nothing.
 *
 * Idempotent. Safe to call on every turn.
 */
export function ensureOurPathSeeded(
  ourPath: string,
  seedPath: string | null | undefined
): void {
  if (!seedPath || seedPath === ourPath || !existsSync(seedPath)) return;

  // Has ourPath already been seeded? Check the head for the sentinel.
  const ourExists = existsSync(ourPath);
  if (ourExists) {
    const head = readHead(ourPath, 4096);
    if (head.includes(`"${SEED_MARKER_TYPE}"`)) return;
  }

  // Need to seed. Read the seed file once.
  const seedText = readAllUtf8(seedPath);
  if (!seedText.trim()) return; // empty seed, nothing to do
  // Ensure the seed text ends with a newline so events stay line-separated.
  const seedNorm = seedText.endsWith('\n') ? seedText : seedText + '\n';
  const marker =
    JSON.stringify({
      type: SEED_MARKER_TYPE,
      seededFrom: seedPath,
      seededAt: new Date().toISOString(),
    }) + '\n';

  if (!ourExists) {
    // First-time init for an imported session.
    writeFileSync(ourPath, marker + seedNorm, 'utf8');
    log.info(`[sessionRuntime] seeded ${ourPath} from ${seedPath}`);
    return;
  }

  // Repair case: ourPath has events written without the seed prefix. Prepend
  // the seed so the file becomes a complete continuation.
  const ourText = readAllUtf8(ourPath);
  writeFileSync(ourPath, marker + seedNorm + ourText, 'utf8');
  log.warn(`[sessionRuntime] repaired ${ourPath} by prepending seed from ${seedPath}`);
}

/** Returns one big string of all bytes in the file, decoded as UTF-8. */
function readAllUtf8(path: string): string {
  const stat = statSync(path);
  if (stat.size === 0) return '';
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      read += readSync(fd, buf, read, stat.size - read, read);
    }
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Sanitize a sequence of messages so it satisfies the Anthropic API's strict
 * tool_use ↔ tool_result pairing rules:
 *
 *   1. Every `tool_result` block in a user message must reference a
 *      `tool_use` ID emitted by the IMMEDIATELY preceding assistant message.
 *   2. Every `tool_use` block emitted by an assistant message must have a
 *      matching `tool_result` in the next user message.
 *
 * Real-world JSONL files violate these rules in several ways:
 *
 *   - Claude Code `/resume` creates a continuation JSONL that starts with a
 *     user tool_result whose tool_use lived in the prior file.
 *   - A session was killed mid-turn (assistant emitted tool_use but the tool
 *     never ran or its result was never persisted).
 *   - Sub-agent / sidechain events get interleaved into the linear log.
 *
 * Strategy:
 *   - Forward pass: drop any `tool_result` whose `tool_use_id` we haven't seen
 *     in a prior assistant message within this loaded slice.
 *   - Backward pass: for any `tool_use` not followed by a matching
 *     `tool_result`, synthesize a placeholder result so the API contract is
 *     preserved without losing the model's earlier decision.
 *   - Drop any message whose content array is empty after sanitization.
 *
 * The transformation is idempotent and never removes plain text content.
 */
/** The API's per-dimension image cap for many-image requests. */
const MAX_IMAGE_DIMENSION_PX = 2000;

/**
 * Whether base64 data really is a supported image (png/jpeg/gif/webp) by its
 * magic bytes. Guards against non-image data (e.g. a PDF) that was mislabeled
 * as an image, which the API rejects with "Could not process image".
 */
function dataIsRealImage(dataB64: string): boolean {
  try {
    const head = Buffer.from(dataB64.slice(0, 24), 'base64');
    if (head.length < 12) return false;
    if (head.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return true; // PNG
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true; // JPEG
    const s6 = head.slice(0, 6).toString('latin1');
    if (s6 === 'GIF87a' || s6 === 'GIF89a') return true; // GIF
    if (head.slice(0, 4).toString('latin1') === 'RIFF' && head.slice(8, 12).toString('latin1') === 'WEBP')
      return true; // WEBP
    return false;
  } catch {
    // If we can't even decode it, treat it as not-a-real-image (safer to drop).
    return false;
  }
}

/**
 * Read an image's pixel dimensions from its header bytes (no decode / no
 * library) and report whether either side exceeds the limit. Supports PNG,
 * GIF, and JPEG. Unknown formats return false (we don't block what we can't
 * measure). Base64 is only partially decoded (headers are tiny).
 */
function imageExceedsLimit(mediaType: string | undefined, dataB64: string): boolean {
  try {
    // The dimensions live in the first ~few hundred bytes for these formats;
    // decode a small prefix only.
    const head = Buffer.from(dataB64.slice(0, 4096), 'base64');
    if (head.length < 12) return false;
    const hex8 = head.slice(0, 8).toString('hex');
    // PNG: 8-byte sig, then IHDR length(4)+type(4)+width(4)+height(4).
    if (hex8 === '89504e470d0a1a0a') {
      const w = head.readUInt32BE(16);
      const h = head.readUInt32BE(20);
      return w > MAX_IMAGE_DIMENSION_PX || h > MAX_IMAGE_DIMENSION_PX;
    }
    // GIF: "GIF87a"/"GIF89a", then width(2 LE) + height(2 LE).
    if (head.slice(0, 3).toString('ascii') === 'GIF') {
      const w = head.readUInt16LE(6);
      const h = head.readUInt16LE(8);
      return w > MAX_IMAGE_DIMENSION_PX || h > MAX_IMAGE_DIMENSION_PX;
    }
    // JPEG: scan SOFn markers for dimensions (need more bytes; decode more).
    if (head[0] === 0xff && head[1] === 0xd8) {
      const buf = Buffer.from(dataB64, 'base64');
      let i = 2;
      while (i < buf.length - 9) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry dimensions.
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          return w > MAX_IMAGE_DIMENSION_PX || h > MAX_IMAGE_DIMENSION_PX;
        }
        const segLen = buf.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
      return false;
    }
    void mediaType;
    return false;
  } catch {
    return false;
  }
}

export function sanitizeMessages(
  messages: Anthropic.MessageParam[],
  knownToolNames?: Set<string>
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  // -- Pass -1: strip `thinking` / `redacted_thinking` blocks ----------------
  // We do NOT send the `thinking` request param (extended thinking is off),
  // so any thinking block in the OUTBOUND history is invalid. The API
  // rejects it with, e.g.:
  //
  //   400 invalid_request_error
  //   "messages.565.content.0.thinking: each thinking block must contain
  //    thinking"
  //
  // How a thinking block ends up in our history despite thinking being off:
  //   - The live loop pushes the SDK's `response.content` verbatim into the
  //     message array (agent.ts) and persists it to JSONL. If the model ever
  //     returns a thinking (or redacted_thinking) block — including an EMPTY
  //     one from a partial/interrupted stream assembly — it gets re-sent on
  //     the next API call and trips the 400. The empty-thinking variant is
  //     exactly what "each thinking block must contain thinking" means.
  //   - Imported Claude Code sessions were recorded WITH extended thinking,
  //     so their JSONL is full of thinking blocks. (loadMessagesFromJsonl
  //     already strips these, but stripping here too makes every path safe
  //     and keeps the invariant in one obvious place.)
  //
  // This pass is idempotent and runs before everything else so later passes
  // (tool pairing, alternation) operate on clean content. Assistant messages
  // whose ONLY block was a thinking block become empty and are dropped here;
  // pass 3's same-role-merge + tail-fixup handle any resulting adjacency.
  {
    let strippedAny = false;
    const deThunk = messages.map((m) => {
      if (typeof m.content === 'string') return m;
      if (!Array.isArray(m.content)) return m;
      const kept = m.content.filter(
        (b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking'
      );
      if (kept.length !== m.content.length) {
        strippedAny = true;
        return { ...m, content: kept as any };
      }
      return m;
    });
    if (strippedAny) {
      // Drop messages emptied by the strip so we don't emit a zero-block
      // content array (the API rejects empty content too).
      messages = deThunk.filter((m) => {
        if (typeof m.content === 'string') return true;
        return Array.isArray(m.content) && m.content.length > 0;
      });
      log.warn('[sessionRuntime] stripped thinking/redacted_thinking block(s) from outbound history');
      if (messages.length === 0) return messages;
    }
  }

  // -- Pass -0.5: neutralize images that exceed the API's per-dimension limit -
  // The API rejects images larger than 2000px in either dimension on
  // many-image requests:
  //
  //   400 invalid_request_error
  //   "messages.66.content.1.image.source.base64.data: At least one of the
  //    image dimensions exceed max allowed size for many-image requests:
  //    2000 pixels"
  //
  // and because the offending image lives in the history, EVERY subsequent
  // turn re-sends it and fails - wedging the session. The composer downscales
  // images at attach time, but this is the last-line defense for anything that
  // slipped through (imports, older sessions, a future code path). We can't
  // re-encode here without an image library, so we drop the oversized image
  // and leave a short text marker in its place.
  // Also drops image blocks whose base64 data is NOT actually a supported image
  // (png/jpeg/gif/webp) - e.g. a PDF that ShowImage mislabeled as image/png.
  // Such a block makes the API reject the request ("Could not process image")
  // on every turn, wedging the session exactly like the oversized case. This
  // applies to top-level image blocks AND images nested inside tool_result
  // content (where ShowImage results live).
  {
    let droppedOversized = false;
    let droppedBad = false;
    // Returns a replacement text block if `b` is a bad/oversized image, else null.
    const badImageReplacement = (b: any): { type: 'text'; text: string } | null => {
      if (b?.type !== 'image' || b.source?.type !== 'base64' || typeof b.source.data !== 'string') {
        return null;
      }
      if (!dataIsRealImage(b.source.data)) {
        droppedBad = true;
        return { type: 'text', text: '[image removed: the file was not a displayable image]' };
      }
      if (imageExceedsLimit(b.source.media_type, b.source.data)) {
        droppedOversized = true;
        return { type: 'text', text: '[image removed: exceeded the 2000px size limit]' };
      }
      return null;
    };
    const sanitizeBlocks = (blocks: any[]): { blocks: any[]; touched: boolean } => {
      let touched = false;
      const out = blocks.map((b) => {
        const rep = badImageReplacement(b);
        if (rep) {
          touched = true;
          return rep;
        }
        // Recurse into tool_result content (ShowImage images live here).
        if (b?.type === 'tool_result' && Array.isArray(b.content)) {
          const inner = sanitizeBlocks(b.content);
          if (inner.touched) {
            touched = true;
            // Never leave a tool_result with an empty content array.
            const content = inner.blocks.length
              ? inner.blocks
              : [{ type: 'text', text: '[image removed]' }];
            return { ...b, content };
          }
        }
        return b;
      });
      return { blocks: out, touched };
    };
    messages = messages.map((m) => {
      if (typeof m.content === 'string' || !Array.isArray(m.content)) return m;
      const res = sanitizeBlocks(m.content as any[]);
      return res.touched ? { ...m, content: res.blocks as any } : m;
    });
    if (droppedOversized) {
      log.warn('[sessionRuntime] dropped oversized image(s) (>2000px) from outbound history');
    }
    if (droppedBad) {
      log.warn('[sessionRuntime] dropped non-image data mislabeled as an image from outbound history');
    }
  }

  // -- Pass 0: drop tool_use blocks for tools that no longer exist -----------
  // Real-world failure: MCP servers sometimes get keyed by random UUIDs in
  // older sessions (e.g. imported Claude Code transcripts where the slack
  // server was named `1db835b8-ad11-...` instead of `slack`). When the user
  // resumes the session, the current MCP registry generates DIFFERENT tool
  // names like `mcp__slack__slack_send_message`, and the API rejects with:
  //
  //   "Tool reference 'mcp__1db835b8-...__slack_send_message' not found in
  //    available tools"
  //
  // Strategy: walk every assistant message; if a tool_use's name isn't in
  // the current registry, drop the tool_use block AND remember its ID so
  // the matching tool_result can also be dropped. We don't try to "rewrite"
  // the tool name to a current equivalent — there's no reliable mapping
  // and a wrong rewrite could lead to bad behavior.
  let preFiltered = messages;
  if (knownToolNames) {
    const droppedToolUseIds = new Set<string>();
    preFiltered = messages.map((m) => {
      if (typeof m.content === 'string') return m;
      const newContent = m.content.filter((b: any) => {
        if (b.type === 'tool_use' && b.name && !knownToolNames.has(b.name)) {
          if (b.id) droppedToolUseIds.add(b.id);
          log.warn(
            `[sessionRuntime] dropping tool_use for unknown tool '${b.name}' (id=${b.id ?? '?'})`
          );
          return false;
        }
        return true;
      });
      return newContent.length === m.content.length ? m : ({ ...m, content: newContent as any });
    });
    if (droppedToolUseIds.size > 0) {
      // Second pass: strip matching tool_results.
      preFiltered = preFiltered.map((m) => {
        if (typeof m.content === 'string') return m;
        const newContent = m.content.filter((b: any) => {
          if (b.type === 'tool_result' && b.tool_use_id && droppedToolUseIds.has(b.tool_use_id)) {
            return false;
          }
          return true;
        });
        return newContent.length === m.content.length ? m : ({ ...m, content: newContent as any });
      });
    }
    // Drop messages that became fully empty.
    preFiltered = preFiltered.filter((m) => {
      if (typeof m.content === 'string') return true;
      return m.content.length > 0;
    });
  }
  // From here on, work with the (possibly filtered) message stream.
  messages = preFiltered;
  if (messages.length === 0) return messages;

  // -- Pass 1: drop orphaned tool_results ------------------------------------
  // The Anthropic API rejects any `tool_result` whose matching `tool_use` is
  // not in the IMMEDIATELY preceding assistant message:
  //
  //   "messages.756.content.1: unexpected `tool_use_id` found in
  //    `tool_result` blocks: toolu_018bcQoeQzmYuhxJPq6zKpxv. Each
  //    `tool_result` block must have a corresponding `tool_use` block in the
  //    previous message."
  //
  // Each tool_use ID is also "consumed" by its matching tool_result —
  // duplicates referencing the same ID later are orphans. Real-world
  // conversations produce such duplicates via:
  //
  //   - Imported Claude Code sessions where a sub-agent / sidechain emitted
  //     a tool_result envelope that gets flattened into the linear log.
  //   - A tool that retried after a transient failure and the retried result
  //     was logged twice.
  //   - Manual session edits.
  //
  // Strategy: track the IMMEDIATELY previous assistant's unmatched tool_use
  // IDs. When we see a tool_result, accept it iff its ID is still pending,
  // then mark it consumed.
  let pendingToolUseIds = new Set<string>();
  const pass1: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      pass1.push(m);
      // String-content messages don't introduce tool_uses; if it's an
      // assistant turn, clear pending IDs since the next user message
      // can't reference them anymore.
      if (m.role === 'assistant') pendingToolUseIds = new Set();
      continue;
    }
    const newContent = m.content.filter((b: any) => {
      if (b.type === 'tool_result') {
        if (!b.tool_use_id || !pendingToolUseIds.has(b.tool_use_id)) {
          log.warn(
            `[sessionRuntime] dropping orphaned tool_result (id=${b.tool_use_id ?? '?'})`
          );
          return false;
        }
        // Consume the ID so a later duplicate tool_result (same id) gets
        // dropped on the next iteration.
        pendingToolUseIds.delete(b.tool_use_id);
      }
      return true;
    });
    if (m.role === 'assistant') {
      // Reset the pending set to JUST this message's tool_uses. Any
      // unmatched tool_uses from the previous assistant turn are gone —
      // pass 2 below synthesizes placeholder results for them.
      pendingToolUseIds = new Set();
      for (const b of newContent) {
        if ((b as any).type === 'tool_use' && (b as any).id) {
          pendingToolUseIds.add((b as any).id);
        }
      }
    }
    if (newContent.length > 0) {
      pass1.push({ ...m, content: newContent as any });
    }
  }

  // -- Pass 2: synthesize placeholder results for unmatched tool_use ---------
  // Walk pairs (assistant, next-user). Any tool_use in the assistant message
  // that lacks a matching tool_result in the next user message gets a synthetic
  // result inserted. If there's no following user message at all, we append one.
  const pass2: Anthropic.MessageParam[] = [];
  for (let i = 0; i < pass1.length; i++) {
    const m = pass1[i];
    pass2.push(m);
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const toolUses = m.content.filter((b: any) => b.type === 'tool_use') as any[];
    if (toolUses.length === 0) continue;

    const next = pass1[i + 1];
    const nextResults: Set<string> = new Set();
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const b of next.content as any[]) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          nextResults.add(b.tool_use_id);
        }
      }
    }
    const missing = toolUses.filter((tu) => !nextResults.has(tu.id));
    if (missing.length === 0) continue;

    // Build synthetic tool_result blocks for the missing IDs.
    const synthetic = missing.map((tu) => ({
      type: 'tool_result' as const,
      tool_use_id: tu.id,
      content: '[result missing — session was interrupted before this tool finished]',
      is_error: true,
    }));

    if (next && next.role === 'user' && Array.isArray(next.content)) {
      // Splice synthetic results into the existing user message at the front
      // so they're contiguous with the assistant's tool_use blocks.
      pass1[i + 1] = {
        ...next,
        content: [...synthetic, ...(next.content as any[])] as any,
      };
    } else {
      // No following user message — insert a new one.
      pass2.push({ role: 'user', content: synthetic as any });
      log.warn(
        `[sessionRuntime] inserted synthetic user tool_results for ${missing.length} unmatched tool_use(s)`
      );
    }
  }

  // -- Pass 3: enforce the API's structural rules on the head/tail/alternation
  //
  // Anthropic's Messages API rejects two scenarios that the earlier passes
  // can leave behind:
  //
  //   A. Conversation tail = assistant. The error is "model does not support
  //      assistant message prefill. The conversation must end with a user
  //      message." (Opus 4.7 with 1M context returns this.) This can happen
  //      when Pass 0 drops a final user message whose only blocks were
  //      tool_results for unknown MCP tools, leaving the prior assistant
  //      stranded as the tail.
  //
  //   B. Two consecutive same-role messages. The API silently rejects with
  //      a less specific error. Same root cause: an intermediate message got
  //      filtered out and now its neighbors are adjacent.
  //
  // Strategy: walk pass2 once. Merge any consecutive same-role messages
  // (concatenate their content). Then, if the final message is assistant,
  // append a tiny placeholder user message so the API will accept the
  // request. We err on the side of preserving content — better to send a
  // slightly larger request than to lose the user's last instruction.
  const pass3: Anthropic.MessageParam[] = [];
  for (const m of pass2) {
    const prev = pass3[pass3.length - 1];
    if (prev && prev.role === m.role) {
      // Merge: convert both to array form if needed, then concat.
      const prevBlocks =
        typeof prev.content === 'string'
          ? prev.content.length > 0
            ? [{ type: 'text', text: prev.content }]
            : []
          : (prev.content as any[]);
      const curBlocks =
        typeof m.content === 'string'
          ? m.content.length > 0
            ? [{ type: 'text', text: m.content }]
            : []
          : (m.content as any[]);
      const merged = [...prevBlocks, ...curBlocks];
      pass3[pass3.length - 1] = { ...prev, content: merged as any };
      log.warn(
        `[sessionRuntime] merged consecutive ${m.role} messages (${curBlocks.length} block(s) appended)`
      );
      continue;
    }
    pass3.push(m);
  }
  const tail = pass3[pass3.length - 1];
  if (tail && tail.role === 'assistant') {
    // Insert a placeholder user message so the conversation tail is
    // user. The model interprets this as "the user has nothing new to add;
    // please continue from where you left off."
    pass3.push({
      role: 'user',
      content: '(continue)',
    });
    log.warn(
      `[sessionRuntime] appended placeholder user message — sanitizer would otherwise have left an assistant-tailed conversation`
    );
  }

  return pass3;
}

/**
 * Strip `thinking` / `redacted_thinking` blocks from a single assistant
 * `content` value. Used at the point where the live agent loop pushes the
 * SDK's `response.content` into the running message array AND persists it
 * to JSONL — so neither the in-memory history nor the on-disk transcript
 * ever carries a thinking block (we don't enable extended thinking, so any
 * thinking block is invalid to re-send; see Pass -1 in `sanitizeMessages`).
 *
 * Accepts the raw SDK content (string or block array) and returns the same
 * shape minus thinking blocks. A string passes through unchanged. If every
 * block was a thinking block, returns an empty array (callers/`sanitize`
 * drop empty messages).
 */
export function stripThinkingBlocks(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.filter(
    (b: any) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking'
  );
}

/**
 * Load Anthropic-API-shaped messages from an arbitrary JSONL file
 * (works for both Claude Code's JSONL and our own).
 *
 * - Filters down to events with type=user|assistant
 * - Strips `thinking` blocks (not safe to send back without extended thinking enabled)
 * - Skips events whose content is empty after stripping
 * - Sanitizes tool_use ↔ tool_result pairing (see sanitizeMessages)
 */
/**
 * Agent-side loader. See `loadMessagesWithTsFromJsonl` for the renderer
 * variant. Default cap is generous (1500) because the agent may genuinely
 * need older context for compaction — but for an imported 35K-message
 * session, processing the entire history every turn is wasted work since
 * compaction will summarize/drop everything older than the tail anyway.
 *
 * Pass `null` to load everything (currently used by no caller; reserved for
 * tests or one-off audits).
 */
export function loadMessagesFromJsonl(
  path: string,
  limit: number | null = 1500
): Anthropic.MessageParam[] {
  if (!existsSync(path)) return [];
  const out: Anthropic.MessageParam[] = [];
  const text = readAllUtf8(path);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.type !== 'user' && evt?.type !== 'assistant') continue;
    const msg = evt?.message;
    if (!msg) continue;
    const role: 'user' | 'assistant' = msg.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let content = msg.content;
    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    // Strip thinking blocks; keep tool_use, tool_result, text, image
    const filtered = content
      .filter((b: any) => b?.type !== 'thinking')
      .map((b: any) => {
        // Anthropic SDK rejects unknown fields; pass through known shapes only.
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        if (b.type === 'tool_result') {
          const r: any = { type: 'tool_result', tool_use_id: b.tool_use_id };
          if (b.content !== undefined) r.content = b.content;
          if (b.is_error) r.is_error = true;
          return r;
        }
        if (b.type === 'image') return { type: 'image', source: b.source };
        if (b.type === 'document') {
          // PDF attachments. Preserve the optional `name` field for the UI.
          const d: any = { type: 'document', source: b.source };
          if (typeof b.name === 'string') d.name = b.name;
          return d;
        }
        return null;
      })
      .filter(Boolean);
    if (filtered.length === 0) continue;
    out.push({ role, content: filtered as any });
  }
  // Apply the cap (most recent N) before sanitize so we don't waste cycles
  // pairing tool_use/tool_result blocks in a slice we're about to discard.
  // We accept the small risk of a tool_use orphan at the cap boundary —
  // sanitizeMessages handles that exact case (forward pass drops orphan
  // tool_results whose tool_use is in the dropped head).
  const sliced =
    limit !== null && limit > 0 && out.length > limit
      ? out.slice(out.length - limit)
      : out;
  // Sanitize before returning so callers never see a malformed history.
  // This handles imported Claude Code sessions that may have orphaned blocks
  // from `/resume` continuations, mid-turn kills, or sidechain interleaving.
  return sanitizeMessages(sliced);
}

/**
 * Same as `loadMessagesFromJsonl` but also pulls the per-event timestamp
 * out (as wall-clock ms epoch). Used by the renderer-facing IPC so the
 * chat UI can show "5m ago" labels next to each message.
 */
/**
 * Render-side message loader.
 *
 * IMPORTANT: an imported Claude Code session can be HUGE — we've seen 113 MB
 * JSONL files with 35,000+ valid user/assistant messages. Sending the whole
 * thing through Electron IPC (≥100 MB JSON payload) hangs or crashes the
 * renderer, and rendering 35K React message bubbles is unusable anyway.
 *
 * The agent loop reads its own copy via `loadMessagesFromJsonl` and manages
 * model context independently (ephemeralize + compact), so this cap purely
 * limits what the UI displays. Older history is still queryable via the
 * `search_conversation` tool.
 *
 * Pass `limit` to bound the count (most recent N messages); `null` means
 * load everything (used by the agent loop, not the renderer).
 */
export function loadMessagesWithTsFromJsonl(
  path: string,
  limit: number | null = 500
): Array<{
  role: 'user' | 'assistant';
  content: any;
  ts: number | null;
}> {
  if (!existsSync(path)) return [];
  const out: Array<{ role: 'user' | 'assistant'; content: any; ts: number | null }> = [];
  const text = readAllUtf8(path);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.type !== 'user' && evt?.type !== 'assistant') continue;
    const msg = evt?.message;
    if (!msg) continue;
    const role: 'user' | 'assistant' = msg.role;
    if (role !== 'user' && role !== 'assistant') continue;
    let ts: number | null = null;
    if (typeof evt.timestamp === 'string') {
      const t = Date.parse(evt.timestamp);
      if (Number.isFinite(t)) ts = t;
    } else if (typeof evt.timestamp === 'number') {
      ts = evt.timestamp;
    }
    let content = msg.content;
    if (typeof content === 'string') {
      out.push({ role, content, ts });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const filtered = content
      .filter((b: any) => b?.type !== 'thinking')
      .map((b: any) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        if (b.type === 'tool_result') {
          const r: any = { type: 'tool_result', tool_use_id: b.tool_use_id };
          if (b.content !== undefined) r.content = b.content;
          if (b.is_error) r.is_error = true;
          return r;
        }
        if (b.type === 'image') return { type: 'image', source: b.source };
        if (b.type === 'document') {
          // PDF attachments. Preserve the optional `name` field for the UI.
          const d: any = { type: 'document', source: b.source };
          if (typeof b.name === 'string') d.name = b.name;
          return d;
        }
        return null;
      })
      .filter(Boolean);
    if (filtered.length === 0) continue;
    out.push({ role, content: filtered, ts });
  }
  // Apply the renderer cap (last N messages) if requested. We walk the whole
  // file even when capping because (a) it's fast — 350ms for a 113 MB file —
  // and (b) we need to know the chronological order to keep the *most recent*
  // window. Slicing at the end is correct since we appended in file order.
  if (limit !== null && limit > 0 && out.length > limit) {
    return out.slice(out.length - limit);
  }
  return out;
}

/** Replace contents of a JSONL atomically (used for compaction later). */
export function rewriteJsonl(path: string, lines: string[]) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  // rename
  try {
    require('node:fs').renameSync(tmp, path);
  } catch (e) {
    log.error('[runtime] rewriteJsonl rename failed', e);
    throw e;
  }
}

export function platformShortName(): string {
  switch (process.platform) {
    case 'win32':
      return 'win32';
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    default:
      return process.platform;
  }
}
