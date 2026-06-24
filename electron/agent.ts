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
  DEFAULT_EFFORT,
  REFUSAL_FALLBACK_MODEL,
} from './anthropic';
import {
  appendJsonlEvent,
  ensureOurPathSeeded,
  loadMessagesFromJsonl,
  ourJsonlPath,
  platformShortName,
  sanitizeMessages,
  stripThinkingBlocks,
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
  isSessionArchived,
  setSessionState,
  setSessionPending,
  setSessionWakeAt,
  getSessionPending,
  getSessionApiKey,
  listSessionsAll,
  listSleepingToolSessions,
  listWaitingOnSystemSessions,
  upsertSession,
  getSetting,
  setSetting,
} from './db';
import { getDefaultApiKeyId } from './secret';
import { computeCostMicros } from './pricing';
import { loadMemory } from './memory';
import { loadRelevantMemory } from './memoryRetrieval';
import { precheckCall } from './budget';
import {
  looksLikeContextBail,
  buildContextBailNudge,
} from './contextBailGuard';
import {
  saveTextAttachment,
  buildAttachmentPreview,
} from './attachments';
import { extractOfficeText, type OfficeKind } from './office';
import { rtfToText } from './rtf';
import { classifyApiError, isTransientApiError } from './apiErrors';
import {
  sleepUnlessAborted,
  DEFAULT_TRANSIENT_RETRY_INTERVAL_MS,
  DEFAULT_TRANSIENT_RETRY_MAX_ATTEMPTS,
} from './transientRetry';
import { maybeSummarize } from './toolSummarizer';
import { loadSkills, renderSkillsBlock, parseSlashCommand, rewriteSlashCommand } from './skills';
import { renderActivePlanBlock } from './planManager';
import { broadcastAgentEvent, broadcastStateChanged } from './agentEvents';
// Server-side `clear_tool_uses_20250919` micro-compaction handles the
// common case of old tool_results bloating context. But it has two
// failure modes:
//   1. It only clears tool_use *results* — user attachments, system
//      prompt, assistant text, and tool_use blocks themselves are
//      untouched.
//   2. It keeps the most recent N tool_uses verbatim. If any single
//      one is huge (multi-MB Read, big Bash output, screenshot), we
//      can still bust the cap.
// So we wrap streamMessage with a client-side pre-flight (run
// `preflightCompactIfNeeded` before sending) and a reactive catch (on
// "prompt is too long" 400, run `emergencyCompact` and retry once).
// Both helpers are in `compaction.ts`.
import {
  preflightCompactIfNeeded,
  emergencyCompact,
  isPromptTooLongError,
  estimateTokens,
} from './compaction';

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
      /** Image blocks from an image-bearing result, for inline display. */
      images?: Array<{ media_type: string; data: string }>;
    }
  | { type: 'usage'; sessionId: string; costUsdMicros: number; usage: any }
  | {
      type: 'wait_for_user';
      sessionId: string;
      id: string;
      question: string;
    }
  | { type: 'turn_done'; sessionId: string; stopReason: string | null }
  // ---- Subagent live activity (Task / Plan / Execute / Review) ----
  // While a subagent runs, the parent turn is blocked and the user would
  // otherwise see nothing until the child returns. These stream the child's
  // narration + tool calls into the SAME conversation window, visually
  // attributed to the subagent, so you can watch it work in real time.
  | {
      type: 'subagent_start';
      sessionId: string;
      runId: string;
      role: string;
      description: string;
    }
  | { type: 'subagent_text'; sessionId: string; runId: string; text: string }
  | {
      type: 'subagent_tool';
      sessionId: string;
      runId: string;
      toolId: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'subagent_tool_result';
      sessionId: string;
      runId: string;
      toolId: string;
      content: string;
      isError: boolean;
    }
  | { type: 'subagent_done'; sessionId: string; runId: string; ok: boolean }
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
  /**
   * A transient upstream failure (Anthropic 529 overloaded, 5xx, 429, or a
   * connection blip) was caught and the agent is going to wait and retry
   * rather than surface an error. The session stays in a working state —
   * this is NOT an error event. The renderer shows a non-fatal "retrying"
   * status so the user knows it's not hung. Only after `maxAttempts`
   * consecutive failures does a real `error` event fire.
   */
  | {
      type: 'transient_retry';
      sessionId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      message: string;
    }
  | { type: 'error'; sessionId: string; message: string };

const activeRuns = new Map<string, AbortController>();

/**
 * Per-session wake timers for `sleeping-tool` sessions. Set by
 * `armWakeTimer` when a tool with `sleepUntil` puts the session to
 * sleep; cleared on wake / cancel / archive. Map cardinality matches
 * the live count of sleeping-tool sessions (rare in practice — there's
 * usually 0 or 1, never hundreds), so we don't optimize storage.
 *
 * The timers are `.unref()`'d so they DON'T keep the Electron main
 * process alive on quit. The DB row's `wake_at_ts` IS durable, so a
 * shutdown-while-sleeping is handled by the post-restart sweep instead.
 */
const wakeTimers = new Map<string, NodeJS.Timeout>();

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
 * Cancel an in-flight turn OR a sleeping-tool wait. Aborts the
 * AbortController so the Anthropic stream and any signal-aware tools
 * (SHELL, GREP, WaitFor*) tear down. A watchdog forcibly cleans up
 * `activeRuns` if the run is still mapped after a grace period —
 * defense in depth against any future tool that forgets to honor the
 * signal. Without this, a hung tool wedges the session in "running"
 * forever and no further messages can be sent.
 *
 * Also cancels the wake timer for sleeping-tool sessions and idles
 * them — without this branch, a user clicking Stop on a sleeping
 * session would see nothing happen (the in-flight wait doesn't have
 * an AbortController to fire).
 */
export function cancelRun(sessionId: string) {
  // Tear down any sleep wake timer + idle the row if we're in
  // sleeping-tool. We do this first so the renderer sees the state
  // transition immediately even if there was no live stream.
  const sleepTimer = wakeTimers.get(sessionId);
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    wakeTimers.delete(sessionId);
    log.info(`[agent] cancelled wake timer for sleeping-tool session ${sessionId}`);
  }
  try {
    const row = listSessionsAll().find((s) => s.id === sessionId);
    if (row?.state === 'sleeping-tool') {
      setSessionWakeAt(sessionId, null);
      setSessionState(sessionId, 'idle');
      broadcastStateChanged(sessionId, 'idle');
      broadcastAgentEvent({
        type: 'turn_done',
        sessionId,
        stopReason: 'cancelled-sleep',
      });
    }
  } catch (e) {
    log.warn('[agent] cancel-sleep cleanup failed', e);
  }
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

// ---- Sleeping-tool wake machinery --------------------------------------

/**
 * Arm an in-process wake timer for a session that just entered
 * `sleeping-tool` state. Two-pronged wake-up strategy:
 *
 *   • This timer is fast and precise — fires the moment `wakeAtTs` is
 *     reached, while the app is still running.
 *   • The governor's `wakeSleepingToolSweep` (every 60 s + once at
 *     startup) is the durable backup — handles the case where the app
 *     was killed/restarted between sleep and wake, so the timer is
 *     long gone.
 *
 * Both paths converge on `wakeSleepingTool(sessionId)`, which is
 * idempotent (state check + activeRuns check) so a race between them
 * is safe.
 *
 * Clamped: never fires immediately — even a wake_at_ts already in the
 * past gets at least a 0 ms scheduling slot, so we don't recurse into
 * runUserTurn synchronously from inside the agent loop's `finally`.
 * `.unref()` so the timer doesn't keep the Electron main process from
 * exiting cleanly on quit.
 */
function armWakeTimer(sessionId: string, wakeAtTs: number) {
  const prev = wakeTimers.get(sessionId);
  if (prev) {
    clearTimeout(prev);
    log.info(`[agent] re-arming wake timer for ${sessionId} (previous was active)`);
  }
  // Node's setTimeout fires IMMEDIATELY if the delay exceeds ~24.8 days
  // (2^31-1 ms). For very-long sleeps, cap each timer hop well under that
  // (1 day) and RE-ARM when it fires but the real wake time hasn't arrived yet.
  // (The governor's 60s sweep is the durable backstop across restarts.)
  const MAX_TIMER_DELAY = 24 * 60 * 60 * 1000; // 1 day per hop
  const remaining = Math.max(0, wakeAtTs - Date.now());
  const delay = Math.min(MAX_TIMER_DELAY, remaining);
  const t = setTimeout(() => {
    wakeTimers.delete(sessionId);
    if (Date.now() < wakeAtTs) {
      // Long sleep: another hop is needed before the real wake time.
      armWakeTimer(sessionId, wakeAtTs);
      return;
    }
    wakeSleepingTool(sessionId).catch((e) =>
      log.error(`[agent] wake timer fired for ${sessionId} but resume failed`, e)
    );
  }, delay);
  t.unref();
  wakeTimers.set(sessionId, t);
  log.info(
    `[agent] armed wake timer for ${sessionId} in ${delay}ms (wake at ${new Date(wakeAtTs).toISOString()})`
  );
}

/**
 * Resume a `sleeping-tool` session. Idempotent: if the session has
 * been cancelled, archived, woken by a parallel path, or is currently
 * already running, this returns without doing anything.
 *
 * On a successful resume:
 *   1. Clear `wake_at_ts` so a second wake fires don't re-resume.
 *   2. Re-enter the agent loop via `runUserTurn` with
 *      `continueExisting: true` — the JSONL already contains a
 *      well-formed tool_result for the WaitForTime, so streamMessage
 *      can be called immediately on the existing history.
 *
 * Exported so the budget governor's sweep can call it on app
 * startup for sleepers whose moment passed while the app was down.
 */
export async function wakeSleepingTool(sessionId: string) {
  const row = listSessionsAll().find((s) => s.id === sessionId);
  if (!row) {
    log.info(`[agent] wake skipped: session ${sessionId} not found`);
    return;
  }
  if (row.archived === 1) {
    log.info(`[agent] wake skipped: session ${sessionId} is archived`);
    // Also clear the wake marker so a later unarchive doesn't
    // immediately re-trigger.
    try {
      setSessionWakeAt(sessionId, null);
    } catch {
      /* non-fatal */
    }
    return;
  }
  if (row.state !== 'sleeping-tool') {
    log.info(
      `[agent] wake skipped: session ${sessionId} state is ${row.state} (not sleeping-tool)`
    );
    return;
  }
  if (activeRuns.has(sessionId)) {
    log.info(`[agent] wake skipped: session ${sessionId} already has an active run`);
    return;
  }
  // Clear wake marker BEFORE the resume call so a tight-race
  // re-trigger doesn't double-resume.
  setSessionWakeAt(sessionId, null);
  log.info(`[agent] waking sleeping-tool session ${sessionId}`);
  await runUserTurn({
    sessionId,
    projectId: row.project_id,
    cwd: row.cwd ?? '',
    userText: '',
    continueExisting: true,
    seedFromJsonl: row.jsonl_path,
  });
}

/**
 * Catch-up sweep for the persistent-sleep state. Called once at app
 * startup (before the governor's interval timer kicks in) and on every
 * resumeSweep tick thereafter. Walks all `sleeping-tool` sessions and:
 *
 *   • If `wake_at_ts <= now`: wake immediately via `wakeSleepingTool`.
 *   • Otherwise: re-arm the in-process wake timer (so a session that
 *     was sleeping when the app died gets back its low-latency wake
 *     after restart). Idempotent — armWakeTimer clears any previous
 *     timer for the same session.
 *
 * Archived sessions are skipped — the archive IPC handler already
 * clears their wake marker, but a legacy archived sleeping-tool row
 * could still exist (cleaned up by `resetArchivedRunningSessions`
 * during the same startup sequence).
 */
export async function wakeSleepingToolSweep() {
  const sleepers = listSleepingToolSessions();
  if (sleepers.length === 0) return;
  const now = Date.now();
  for (const s of sleepers) {
    if (s.archived === 1) {
      log.info(
        `[agent] sweep: skipping archived sleeping-tool session ${s.id}`
      );
      continue;
    }
    if (s.wake_at_ts == null) {
      // Defensive: a session in sleeping-tool with no wake_at_ts is
      // malformed. Idle it so the user can resume manually.
      log.warn(
        `[agent] sweep: session ${s.id} is sleeping-tool but wake_at_ts is null; idling`
      );
      try {
        setSessionState(s.id, 'idle');
        broadcastStateChanged(s.id, 'idle');
      } catch {
        /* non-fatal */
      }
      continue;
    }
    if (s.wake_at_ts <= now) {
      // Past wake — fire immediately. Don't await in the loop so a
      // single slow resume doesn't block other sleepers.
      wakeSleepingTool(s.id).catch((e) =>
        log.error(`[agent] sweep wake of ${s.id} failed`, e)
      );
    } else {
      // Future wake — make sure the in-process timer is armed. After
      // app restart this is the only path that re-creates the
      // timer; without it, low-latency wake would be lost until the
      // next 60s sweep tick.
      armWakeTimer(s.id, s.wake_at_ts);
    }
  }
}

/**
 * Resume sessions that were parked in `waiting-on-system` (a WaitForFile /
 * WaitForProcess / WaitForHttp poll) when the app died. Those tools run an
 * in-process polling loop that does NOT survive a restart, so without this
 * the session would be stuck (the old behavior idled it — the bug Jason
 * reported: "a WaitForFile session comes back idle after a restart").
 *
 * We re-enter the turn via `runUserTurn({ continueExisting: true })`, the
 * same mechanism `wakeSleepingTool` uses. The JSONL conversation is intact;
 * `sanitizeMessages` synthesizes a placeholder tool_result for the
 * interrupted Wait* call (its tool_use has no matching result on disk), so
 * the API contract holds and the model continues — typically re-issuing the
 * wait, which is exactly the desired behavior.
 *
 * Called once at startup (after resetStaleRunningSessions, which now leaves
 * `waiting-on-system` rows alone). Idempotent per session via the
 * activeRuns guard inside runUserTurn.
 */
export async function resumeWaitingOnSystemSessions() {
  const waiting = listWaitingOnSystemSessions();
  if (waiting.length === 0) return;
  log.info(`[agent] resuming ${waiting.length} waiting-on-system session(s) after restart`);
  for (const s of waiting) {
    if (activeRuns.has(s.id)) continue;
    log.info(`[agent] resuming waiting-on-system session ${s.id}`);
    // Don't await in the loop — one slow resume shouldn't block the others.
    runUserTurn({
      sessionId: s.id,
      projectId: s.project_id,
      cwd: s.cwd ?? '',
      userText: '',
      continueExisting: true,
      seedFromJsonl: s.jsonl_path,
    }).catch((e) => log.error(`[agent] resume of waiting-on-system ${s.id} failed`, e));
  }
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
  | { kind: 'text'; name?: string; text: string }
  /**
   * Disk-backed text attachment. Renderer ships the full content
   * here; main writes it under `~/.guycode/attachments/<sessionId>/`
   * (via `saveTextAttachment`) and emits a reference content block
   * pointing the model at the absolute path. See `electron/attachments.ts`
   * for the storage layout and `buildUserContent` below for the
   * reference-block format.
   */
  | { kind: 'text-file'; name?: string; text: string }
  /**
   * Rich document (docx/xlsx/pptx/rtf). Renderer ships base64 of the
   * original file bytes; main decodes, extracts text (office via
   * `extractOfficeText`, rtf via `rtfToText`), then writes the extracted
   * text disk-backed (same as `text-file`).
   */
  | {
      kind: 'rich-doc';
      name?: string;
      docKind: OfficeKind | 'rtf';
      dataBase64: string;
    };

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
    } else if (r.kind === 'text-file' && typeof r.text === 'string') {
      // Disk-backed text. Same wire shape as `text` (full content
      // crosses IPC) but flagged so `buildUserContent` writes it to
      // a per-session attachment dir and emits a path-reference
      // block instead of inlining the full content.
      out.push({
        kind: 'text-file',
        name: typeof r.name === 'string' ? r.name : undefined,
        text: r.text,
      });
    } else if (
      r.kind === 'rich-doc' &&
      typeof r.dataBase64 === 'string' &&
      (r.docKind === 'docx' ||
        r.docKind === 'xlsx' ||
        r.docKind === 'pptx' ||
        r.docKind === 'rtf')
    ) {
      // Rich document (docx/xlsx/pptx/rtf). Carries base64 of the original
      // file bytes; main extracts text in `buildUserContent` and routes it
      // disk-backed.
      out.push({
        kind: 'rich-doc',
        name: typeof r.name === 'string' ? r.name : undefined,
        docKind: r.docKind,
        dataBase64: r.dataBase64,
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
function buildUserContent(
  text: string,
  attachments: IncomingAttachment[],
  sessionId: string
): unknown {
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
    } else if (a.kind === 'text-file') {
      // ---- Disk-backed text attachment (v0.1.6+) -----------------
      //
      // The renderer routed this here because the file exceeded the
      // inline threshold (~200KB). We:
      //   1. Write the full content to `<userData>/.guycode/attachments/
      //      <sessionId>/<sanitized-name>` via `saveTextAttachment`.
      //   2. Emit a small reference text block in place of the
      //      content. The model sees: file name, exact byte count,
      //      absolute path, an instruction to use `Read`, and a
      //      ~500-char preview.
      //
      // This keeps the prompt token cost bounded by the reference
      // block size (~600 chars) regardless of how big the file is,
      // while leaving the model fully able to access any portion
      // via `Read(path, offset, limit)`. The file persists for the
      // life of the session and is deleted alongside the JSONL when
      // the user removes the session.
      //
      // Failure handling: writeFileSync throws synchronously on
      // disk errors (out-of-space, permission). We let it propagate
      // so the agent loop's outer try/catch surfaces it as a turn
      // error rather than silently sending a path that can't be
      // Read.
      const rawName = a.name ?? 'attachment.txt';
      const saved = saveTextAttachment(sessionId, rawName, a.text);
      const sizeKb = Math.max(1, Math.round(saved.sizeBytes / 1024));
      const preview = buildAttachmentPreview(a.text, 500);
      blocks.push({
        type: 'text',
        text:
          `\n\n--- Attached file (too large to inline): ${rawName} ---\n` +
          `Saved at: ${saved.absPath}\n` +
          `Size: ${sizeKb} KB\n` +
          `Use the Read tool with the absolute path above to access the contents. ` +
          `For very large files, pass offset/limit to read in chunks.\n` +
          `\nPreview (first ~500 chars):\n${preview}\n` +
          `--- end ${rawName} ---`,
      });
    } else if (a.kind === 'rich-doc') {
      // ---- Rich document (docx / xlsx / pptx / rtf) --------------
      //
      // We carry the original file bytes (base64) over IPC, decode
      // them here, and extract plain text:
      //   - docx/xlsx/pptx → extractOfficeText (fflate ZIP+XML parse,
      //     see electron/office.ts)
      //   - rtf            → rtfToText (control-word strip,
      //     see electron/rtf.ts)
      // The extracted text is then written disk-backed exactly like a
      // `text-file`, with the saved `.txt` named after the original
      // document so the model can Read it.
      //
      // If extraction fails (corrupt file, not really the claimed
      // format, an encrypted/password-protected document), we emit an
      // error text block instead of failing the whole turn — the user
      // still gets their typed message through, just without the
      // attachment content.
      const label = a.docKind.toUpperCase();
      const rawName = a.name ?? `document.${a.docKind}`;
      let extracted: string;
      try {
        const bytes = Buffer.from(a.dataBase64, 'base64');
        if (a.docKind === 'rtf') {
          extracted = rtfToText(bytes.toString('utf8'));
        } else {
          extracted = extractOfficeText(new Uint8Array(bytes), a.docKind);
        }
      } catch (e) {
        log.warn(`[agent] ${label} extraction failed for ${rawName}: ${(e as Error).message}`);
        blocks.push({
          type: 'text',
          text:
            `\n\n--- Attached ${label} (could not extract text): ${rawName} ---\n` +
            `The file couldn't be parsed (it may be corrupt, password-protected, ` +
            `or saved in an older/unsupported format). Ask the user to re-save it ` +
            `as .${a.docKind} or export to PDF.\n` +
            `--- end ${rawName} ---`,
        });
        continue;
      }
      if (!extracted.trim()) {
        blocks.push({
          type: 'text',
          text:
            `\n\n--- Attached ${label}: ${rawName} ---\n` +
            `(No extractable text — the document may contain only images / charts.)\n` +
            `--- end ${rawName} ---`,
        });
        continue;
      }
      // Save the EXTRACTED TEXT under a .txt leaf derived from the
      // original name, so the on-disk file is human-readable and the
      // model Reads plain text rather than a binary blob.
      const txtName = `${rawName}.extracted.txt`;
      const saved = saveTextAttachment(sessionId, txtName, extracted);
      const sizeKb = Math.max(1, Math.round(saved.sizeBytes / 1024));
      const preview = buildAttachmentPreview(extracted, 500);
      blocks.push({
        type: 'text',
        text:
          `\n\n--- Attached ${label} (text extracted): ${rawName} ---\n` +
          `Extracted text saved at: ${saved.absPath}\n` +
          `Extracted size: ${sizeKb} KB\n` +
          `Use the Read tool with the absolute path above to access the full ` +
          `extracted text. For very large files, pass offset/limit to read in ` +
          `chunks. (Formatting/layout is not preserved — this is plain text.)\n` +
          `\nPreview (first ~500 chars):\n${preview}\n` +
          `--- end ${rawName} ---`,
      });
    }
  }
  if (blocks.length === 0) return text;
  return blocks;
}

export function broadcast(e: AgentEvent) {
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
  const { sessionId, projectId, cwd, seedFromJsonl } = args;
  // Slash-command rewriting: a leading `/skill-name [args]` becomes a
  // synthetic user message instructing the model to call the Skill
  // tool with the matched name. We do this before anything else so
  // the JSONL records the canonical (rewritten) form rather than the
  // raw `/feature-spec ...` shorthand. If the slash doesn't match a
  // known skill, the original text passes through unchanged so the
  // user can still type `/path/like/this` as plain text.
  let userText = args.userText;
  if (userText && userText.trimStart().startsWith('/') && !args.continueExisting) {
    try {
      const reg = loadSkills(cwd);
      const match = parseSlashCommand(userText, reg);
      if (match) {
        const rewritten = rewriteSlashCommand(match);
        log.info(
          `[agent] slash command "/${match.skill.name}" rewritten (${userText.length}\u2192${rewritten.length} chars)`
        );
        userText = rewritten;
      }
    } catch (e) {
      // Slash parsing is non-critical; if anything throws we just
      // pass the raw text through. Skill loading errors are also
      // logged inside loadSkills().
      log.warn('[agent] slash-command parse threw; passing raw userText', e);
    }
  }
  const attachments = normalizeAttachments(args.attachments);
  // Archived sessions are inert. The `sessions:archive` IPC handler
  // cancels any in-flight turn and clears pending text on the way in,
  // but a fire-and-forget runUserTurn that was already scheduled
  // (e.g., the resume sweep made a decision microseconds before the
  // archive write landed) could still arrive here. Refuse cleanly —
  // no state mutation, no JSONL append. The user must unarchive to
  // continue. We also catch any caller that bypassed the IPC layer
  // (sub-agent Task delegation, future internal triggers, etc.).
  if (isSessionArchived(sessionId)) {
    log.info(`[agent] refusing to run archived session ${sessionId}`);
    return;
  }
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
      const userContent = buildUserContent(effectiveText, attachments, sessionId);
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

    let model = (getSetting('model') as string) || DEFAULT_MODEL;
    // Effort level for the model (output_config.effort). Defaults to xhigh
    // (DEFAULT_EFFORT). A user who sets effort to '' (or pins a model that
    // doesn't accept output_config) gets it omitted.
    const effortSetting = getSetting('effort');
    const effort = effortSetting === undefined ? DEFAULT_EFFORT : (effortSetting as string);
    const memory = loadMemory({ cwd, projectId });
    if (memory.sources.length > 0) {
      log.info(
        `[agent] loaded memory: ${memory.sources.length} files, ${memory.text.length}b (truncated ${memory.truncatedBytes}b)`
      );
    }
    // Smart memory retrieval: instead of dumping the whole memory tree into the
    // system prompt every turn (costly, dilutes attention, and triggers Fable
    // 5 refusals when security notes are present), load only the pinned core +
    // the notes a cheap model judges relevant to THIS turn's message. Computed
    // ONCE per turn and reused across tool-result rounds. Falls back to the
    // full load on any failure or when disabled. `memory` (the full bundle) is
    // still used for subagents.
    let memText = memory.text;
    let retrievedMemoryText: string | undefined;
    // Smart memory retrieval is OFF by default (it has produced noticeably worse
    // results); only run it when the user has explicitly turned it on.
    const memRetrieval = getSetting('memory_retrieval');
    if (memRetrieval === 'on' && userText && userText.trim()) {
      try {
        // Gate on RECENT CONVERSATION CONTEXT (last few turns) + the active
        // plan + the new message - not just the message - so terse follow-ups
        // ("continue", "now do X") still retrieve the right state. Recent
        // task-state notes are always loaded regardless (see loadRelevantMemory).
        const recentTurns = messages
          .slice(-6)
          .map((m: Anthropic.MessageParam) => {
            const c = m.content;
            const text =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? c
                      .map((b: any) => (b?.type === 'text' ? b.text : b?.type === 'tool_use' ? `[tool:${b.name}]` : ''))
                      .filter(Boolean)
                      .join(' ')
                  : '';
            return text ? `${m.role}: ${text.slice(0, 800)}` : '';
          })
          .filter(Boolean)
          .join('\n');
        const planBlock = renderActivePlanBlock(sessionId) || '';
        const contextText = [
          planBlock ? `Active plan:\n${planBlock}` : '',
          recentTurns ? `Recent conversation:\n${recentTurns}` : '',
          `Latest message:\n${userText}`,
        ]
          .filter(Boolean)
          .join('\n\n');
        const rm = await loadRelevantMemory({
          cwd,
          projectId,
          contextText,
          sessionId,
          apiKeyId: resolvedApiKeyId,
        });
        memText = rm.pinnedText;
        retrievedMemoryText = rm.retrievedText;
        log.info(
          `[agent] memory retrieval via=${rm.via} selected=${rm.selectedNames.length} (${rm.selectedNames.join(', ').slice(0, 200)})`
        );
      } catch (e) {
        log.warn(`[agent] memory retrieval failed, using full load: ${(e as Error).message}`);
      }
    }
    // Smart model routing: route clearly-simple turns to a cheaper model to
    // save cost. Biased to the strong model whenever uncertain; the
    // refusal/empty fallback below still escalates if a cheap turn goes wrong.
    // Default off (opt-in) so it never surprises with a weaker model.
    if (getSetting('routing') === 'on' && userText && userText.trim()) {
      try {
        const { classifyTurn, DEFAULT_CHEAP_MODEL } = await import('./modelRouter');
        const decision = await classifyTurn({
          userText,
          strongModel: model,
          cheapModel: (getSetting('routing.cheapModel') as string) || DEFAULT_CHEAP_MODEL,
          floorModel: (getSetting('routing.floor') as string) || '',
          apiKeyId: resolvedApiKeyId,
        });
        if (decision.model !== model) {
          log.info(`[agent] routing ${decision.tier} -> ${decision.model} (${decision.via}: ${decision.reason})`);
        }
        model = decision.model;
      } catch (e) {
        log.warn(`[agent] routing failed, keeping strong model: ${(e as Error).message}`);
      }
    }
    // If the selected model (Fable 5) already refused in this session, stop
    // calling it - use the fallback model directly so we don't waste a call and
    // show a refusal notice every turn. Tell the user about the switch once.
    if (
      getSetting(`session_refused_${sessionId}`) === '1' &&
      model !== REFUSAL_FALLBACK_MODEL &&
      /fable|mythos/i.test(model)
    ) {
      model = REFUSAL_FALLBACK_MODEL;
      if (getSetting(`session_refused_notified_${sessionId}`) !== '1') {
        setSetting(`session_refused_notified_${sessionId}`, '1');
        onEv({
          type: 'text_delta',
          sessionId,
          text: '_(Claude Fable 5 kept refusing in this session; using Claude Opus 4.8 for the rest of it. Switch models in Settings.)_\n\n',
        });
      }
      log.info(`[agent] session ${sessionId} had a Fable refusal; using ${REFUSAL_FALLBACK_MODEL} directly`);
    }
    // Skills loaded from ~/.guycode/skills, <cwd>/.guycode/skills, and
    // imported from ~/.claude/skills + <cwd>/.claude/skills. The
    // resulting block enumerates name + description so the model can
    // pick by description match. Bodies are fetched on-demand via the
    // Skill tool (see tools.ts).
    const skillRegistry = loadSkills(cwd);
    if (skillRegistry.skills.length > 0) {
      log.info(
        `[agent] loaded ${skillRegistry.skills.length} skill(s) (${skillRegistry.shadowed.length} shadowed by name collision)`
      );
    }
    const systemBlocks = buildSystemBlocks({
      sessionId,
      cwd,
      date: new Date(),
      platform: platformShortName(),
      memoryText: memText,
      retrievedMemoryText,
      skillsBlock: renderSkillsBlock(skillRegistry),
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

    // ---- Context-bail WaitForUser runtime guardrail -------------------
    //
    // Symptom (the v0.1.5 user complaint, verbatim example):
    //   > "Push through to completion now in this same turn (will be
    //   > tight against context budget), OR stop here and let a fresh
    //   > session pick up from the saved memory?"
    //
    // This is the model calling WaitForUser to ask the user for
    // PERMISSION to keep working on the grounds that context might
    // be tight. It's never the right call:
    //   • Anthropic's server-side micro-compaction
    //     (`context_management.clear_tool_uses_20250919`) clears older
    //     tool results in place once we cross the input-token trigger
    //     (600K for 1M context, 150K for 200K).
    //   • Our client-side `preflightCompactIfNeeded` summarizes the
    //     head as a backstop before any request that would otherwise
    //     exceed the cap.
    //   • Saved memory + JSONL + the active-plan slot anchor goal +
    //     progress across compactions; the model doesn't lose its
    //     place. There's no "fresh session needed" scenario.
    //
    // Guardrail: when a WaitForUser fires with a question matching
    // the context-bail pattern, refuse it. Synthesize a tool_result
    // telling the model "context is automatic; keep working", DON'T
    // transition the session to waiting-on-user, DON'T emit the UI
    // wait_for_user event, and continue the loop. Bounded by
    // `MAX_CONTEXT_BAIL_NUDGES` so a genuinely confused model
    // eventually falls through to a real WaitForUser (surfacing the
    // bug to the human instead of looping forever).
    let contextBailNudgesUsed = 0;
    const MAX_CONTEXT_BAIL_NUDGES = 4;

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

      // Per-iteration: sanitize first (defensive backstop for tool pairing
      // and unknown-tool filtering), then run the client-side pre-flight
      // compaction. The pre-flight is a no-op when we're under the safety
      // threshold (~95% of the model's cap); when it fires, it shrinks
      // the head into a summary so the request stays under the cap.
      //
      // We mutate `messages` only when compaction actually changed
      // anything (preflighted !== sanitized) so the compacted form is
      // what gets used by subsequent loop iterations. The on-disk JSONL
      // is the canonical source of truth and is unchanged — compaction
      // is purely a runtime projection.
      const sanitized = sanitizeMessages(messages, knownToolNames);
      let preflighted: Anthropic.MessageParam[] = sanitized;
      try {
        preflighted = await preflightCompactIfNeeded(sanitized, model);
      } catch (e) {
        log.warn('[agent] preflight compaction failed; sending uncompacted', e);
        preflighted = sanitized;
      }
      if (preflighted !== sanitized) {
        // Compaction actually fired. Re-sanitize because the compaction
        // boundary can leave orphaned tool pairings, and replace the
        // working `messages` so subsequent loop iterations see the
        // smaller form.
        messages = sanitizeMessages(preflighted, knownToolNames);
        preflighted = messages;
      }
      let messagesToSend = withConversationCacheBreakpoint(preflighted);

      // Surface the API call to the UI so the "thinking..." gap is visible.
      // Use `estimateTokens` (the same estimator compaction uses) so the
      // surfaced number is consistent with the safety threshold the
      // pre-flight checks against.
      let estTokens = 0;
      try {
        estTokens = estimateTokens(messagesToSend);
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

      // Re-render systemBlocks with the LATEST active plan + currentTask
      // before each call. The skills + memory + intro slots are stable
      // (cached); only the active-plan slot (3.6) and currentTask
      // (slot 4) change frequently. Rebuilding the whole array is
      // cheap (string concat) and keeps the cache prefix valid.
      const refreshedSystemBlocks = buildSystemBlocks({
        sessionId,
        cwd,
        date: new Date(),
        platform: platformShortName(),
        memoryText: memText,
        retrievedMemoryText,
        skillsBlock: renderSkillsBlock(skillRegistry),
        activePlanBlock: renderActivePlanBlock(sessionId),
        currentTask: userText,
      });
      // One-shot prompt-too-long recovery loop. The pre-flight above
      // catches the common case, but it can miss when the estimator
      // under-counts (e.g. base64 image attachments, or a system
      // prompt that itself eats a big chunk of the cap). When the
      // API rejects with "prompt is too long", `emergencyCompact`
      // shrinks aggressively and we retry once. If the retry still
      // fails — or if compaction made no progress — propagate the
      // original error so the outer catch can surface it cleanly.
      let response: Anthropic.Message;
      let promptTooLongAttempts = 0;
      // Transient-error retry state. We retry overloaded (529) / 5xx / 429 /
      // connection failures on a fixed cadence rather than surfacing them
      // immediately, and only give up after a long run of CONSECUTIVE
      // failures. The count resets on any success. Configurable via
      // settings; defaults are ~once-a-minute up to ~15 attempts (~15 min).
      let consecutiveTransient = 0;
      const retryIntervalMs =
        Number(getSetting('transient_retry_interval_ms')) || DEFAULT_TRANSIENT_RETRY_INTERVAL_MS;
      const retryMaxAttempts =
        Number(getSetting('transient_retry_max_attempts')) || DEFAULT_TRANSIENT_RETRY_MAX_ATTEMPTS;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          response = await streamMessage({
            model,
            effort,
            system: refreshedSystemBlocks,
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
          consecutiveTransient = 0; // success — reset the transient run
          break; // success — exit retry loop
        } catch (err: any) {
          // AbortError: user cancelled mid-stream. Re-throw so the
          // outer catch handles it normally (no compaction recovery).
          if (err?.name === 'AbortError') throw err;
          // Transient upstream failure (529 overloaded / 5xx / 429 /
          // connection blip): wait and retry on a fixed cadence rather
          // than aborting the turn. Only surface after a long run of
          // consecutive failures. AbortError is handled above, so a user
          // cancel still takes effect instantly; a cancel DURING the wait
          // is caught by sleepUnlessAborted below.
          if (isTransientApiError(err)) {
            consecutiveTransient++;
            if (consecutiveTransient >= retryMaxAttempts) {
              log.error(
                `[agent] transient API error persisted ${consecutiveTransient}x; surfacing to user`
              );
              throw err;
            }
            const cls = classifyApiError(err);
            log.warn(
              `[agent] transient API error (${cls.category}) attempt ${consecutiveTransient}/${retryMaxAttempts}; retrying in ${retryIntervalMs}ms`
            );
            onEv({
              type: 'transient_retry',
              sessionId,
              attempt: consecutiveTransient,
              maxAttempts: retryMaxAttempts,
              delayMs: retryIntervalMs,
              message: cls.message,
            });
            const slept = await sleepUnlessAborted(retryIntervalMs, ctrl.signal);
            if (slept === 'aborted') {
              const ab: any = new Error('aborted');
              ab.name = 'AbortError';
              throw ab;
            }
            // Reset stream-local state so the retry's awaiting/streaming
            // UI semantics stay correct (mirrors the prompt-too-long path).
            partials.clear();
            pendingText = '';
            firstEventAt = 0;
            let estTok = 0;
            try {
              estTok = estimateTokens(messagesToSend);
            } catch {
              estTok = 0;
            }
            onEv({
              type: 'awaiting_response',
              sessionId,
              estimatedInputTokens: estTok,
              messageCount: messagesToSend.length,
            });
            continue;
          }
          const ptl = isPromptTooLongError(err);
          if (!ptl.hit || promptTooLongAttempts >= 1) throw err;
          promptTooLongAttempts++;
          log.warn(
            `[agent] prompt-too-long: API reported ${ptl.tokens} tokens > cap; emergency-compacting and retrying`
          );
          // Emergency-compact and retry. If compaction can't shrink
          // the payload meaningfully, propagate the original error so
          // the user sees the real failure (not a misleading "still
          // too long" loop). We compare TOKEN estimates, not message
          // count — `ephemeralizeMessages` (the cheap stage 1 of
          // emergency compaction) preserves length while shrinking
          // content, so a length-only check would falsely conclude
          // "no progress" even when content shrank by 90%.
          const beforeTokens = estimateTokens(messages);
          let recovered: Anthropic.MessageParam[];
          try {
            recovered = await emergencyCompact(messages);
          } catch (compactErr) {
            log.error('[agent] emergency compact failed during recovery', compactErr);
            throw err;
          }
          const afterTokens = estimateTokens(recovered);
          // Require at least a 5% reduction. Anything less and the
          // retry is doomed — better to surface the error than to
          // burn another round-trip.
          if (afterTokens >= Math.floor(beforeTokens * 0.95)) {
            log.error(
              `[agent] emergency compact made no progress (${beforeTokens} → ${afterTokens} tokens); propagating original prompt-too-long error`
            );
            throw err;
          }
          log.info(
            `[agent] emergency compact: ${beforeTokens} → ${afterTokens} tokens`
          );
          messages = sanitizeMessages(recovered, knownToolNames);
          messagesToSend = withConversationCacheBreakpoint(messages);
          // Reset stream-local state so the retry's `awaiting_response` /
          // `response_started` semantics stay correct in the UI.
          partials.clear();
          pendingText = '';
          firstEventAt = 0;
          // Re-fire awaiting_response so the UI knows we're still
          // working (the user would otherwise see the streaming
          // spinner pause for the duration of the haiku summarizer
          // round-trip with no explanation).
          let retryEstTokens = 0;
          try {
            retryEstTokens = estimateTokens(messagesToSend);
          } catch {
            retryEstTokens = 0;
          }
          onEv({
            type: 'awaiting_response',
            sessionId,
            estimatedInputTokens: retryEstTokens,
            messageCount: messagesToSend.length,
          });
          // Loop back to retry.
        }
      }

      // Round complete — log timing so the user can see in the console
      // whether slowness was server-side TTFT, generation, or tool work.
      const apiTotalMs = Date.now() - apiStartedAt;
      const ttftMs = firstEventAt > 0 ? firstEventAt - apiStartedAt : -1;
      const generationMs = firstEventAt > 0 ? Date.now() - firstEventAt : -1;
      log.info(
        `[agent] api call done sessionId=${sessionId} total=${apiTotalMs}ms ttft=${ttftMs}ms gen=${generationMs}ms inputTokens=${(response.usage as any)?.input_tokens ?? '?'} cacheReadTokens=${(response.usage as any)?.cache_read_input_tokens ?? '?'} outputTokens=${(response.usage as any)?.output_tokens ?? '?'}`
      );

      stopReason = response.stop_reason;

      // ---- Refusal fallback ----
      // Fable 5 (the heavily-safeguarded public Mythos-class model) can end a
      // turn with stop_reason 'refusal' and EMPTY content - its safety
      // classifier declined to generate on this particular content. It's
      // content-dependent (most turns are fine). Rather than leave a silent
      // blank "needs you" turn, transparently RETRY the same request on a
      // fallback model (Opus 4.8) with a lighter refusal posture, and mark the
      // fallback visibly so the user knows it happened.
      //
      // 'refusal' is a real runtime stop_reason but isn't in our pinned SDK's
      // union type yet, so compare as a string.
      const isRefusal = (response.stop_reason as string) === 'refusal';
      const hasAnyContent = Array.isArray(response.content)
        ? response.content.some(
            (b: any) =>
              (b.type === 'text' && (b.text || '').trim()) || b.type === 'tool_use'
          )
        : false;
      if ((isRefusal || !hasAnyContent) && model !== REFUSAL_FALLBACK_MODEL) {
        // Remember that this session's model refused, so subsequent turns use
        // the fallback model directly instead of wasting a call + showing this
        // notice every turn. Persisted in the DB (single source of truth that
        // survives restarts and avoids any module-instance ambiguity that a
        // module-level Set could have).
        setSetting(`session_refused_${sessionId}`, '1');
        const note =
          `_(Claude Fable 5 declined this turn${isRefusal ? ' (refusal)' : ' (empty response)'}; ` +
          `retrying on Claude Opus 4.8.)_\n\n`;
        onEv({ type: 'text_delta', sessionId, text: note });
        log.warn(
          `[agent] ${isRefusal ? 'refusal' : 'empty'} from ${model} sessionId=${sessionId} - falling back to ${REFUSAL_FALLBACK_MODEL}`
        );
        try {
          const fallbackResponse = await streamMessage({
            model: REFUSAL_FALLBACK_MODEL,
            effort,
            system: refreshedSystemBlocks,
            tools,
            messages: messagesToSend,
            signal: ctrl.signal,
            apiKeyId: resolvedApiKeyId,
            onEvent: (sev) => {
              // Stream the fallback's events through the same handler the main
              // request used (text/tool deltas reach the UI live).
              if (sev.type === 'content_block_delta') {
                if (sev.delta.type === 'text_delta') {
                  pendingText += sev.delta.text;
                  onEv({ type: 'text_delta', sessionId, text: sev.delta.text });
                } else if (sev.delta.type === 'input_json_delta') {
                  const p = partials.get(sev.index);
                  if (p) {
                    p.input += sev.delta.partial_json;
                    onEv({ type: 'tool_use_input_delta', sessionId, id: p.id, partial: sev.delta.partial_json });
                  }
                }
              } else if (sev.type === 'content_block_start') {
                const block = sev.content_block;
                if (block.type === 'tool_use') {
                  partials.set(sev.index, { id: block.id, name: block.name, input: '' });
                  onEv({ type: 'tool_use_start', sessionId, id: block.id, name: block.name });
                }
              } else if (sev.type === 'content_block_stop') {
                const p = partials.get(sev.index);
                if (p) {
                  let parsed: unknown = {};
                  try {
                    parsed = p.input ? JSON.parse(p.input) : {};
                  } catch {
                    parsed = {};
                  }
                  onEv({ type: 'tool_use_done', sessionId, id: p.id, name: p.name, input: parsed });
                }
              }
            },
          });
          // Prepend the visible fallback note to the fallback's content so it
          // persists too, and adopt the fallback response for the rest of the
          // round (tool dispatch, persistence, cost accounting).
          (fallbackResponse.content as any) = [
            { type: 'text', text: note },
            ...(Array.isArray(fallbackResponse.content) ? fallbackResponse.content : []),
          ];
          response = fallbackResponse;
          stopReason = fallbackResponse.stop_reason;
        } catch (fallbackErr) {
          log.error(`[agent] refusal fallback also failed: ${(fallbackErr as Error).message}`);
          const failText =
            'Claude Fable 5 declined this turn and the automatic retry on Claude Opus 4.8 also failed. ' +
            'Try rephrasing, or switch the model in Settings.';
          (response.content as any) = [
            ...(Array.isArray(response.content) ? response.content : []),
            { type: 'text', text: failText },
          ];
          onEv({ type: 'text_delta', sessionId, text: failText });
        }
      }

      // Strip any thinking / redacted_thinking blocks from the model's
      // content BEFORE we persist it or push it back into the running
      // history. We don't enable extended thinking, so a thinking block in
      // the outbound history is invalid and the API rejects it with
      // "each thinking block must contain thinking" (especially the empty
      // variant from a partial stream). `sanitizeMessages` strips these at
      // send time too (Pass -1) as a backstop, but doing it here keeps the
      // JSONL transcript + in-memory array clean in the first place.
      const persistedContent = stripThinkingBlocks(response.content);

      // Persist assistant message + usage
      appendJsonlEvent(ourPath, {
        type: 'assistant',
        uuid: response.id,
        sessionId,
        cwd,
        message: {
          role: 'assistant',
          model: response.model,
          content: persistedContent,
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

      // Append assistant to messages (thinking blocks already stripped).
      messages.push({ role: 'assistant', content: persistedContent as any });

      // Check for tool_use blocks. Read from the original response.content
      // (thinking blocks were never tool_use, so the filter result is
      // identical, and this avoids depending on the stripped shape).
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
        // No more tools — turn is done. BUT first check whether the user
        // typed a follow-up while this turn was running: if there are queued
        // interrupts, we must NOT drop into "needs you" with their message
        // sitting unread. Pick the queued message(s) up as a new user turn and
        // continue the loop, so the next streamMessage answers them. (Without
        // this, a session ends in "needs you" with the user's already-typed
        // message stranded, forcing them to type AGAIN to make it pick up.)
        if (peekInterrupts(sessionId) > 0) {
          const queued = drainInterrupts(sessionId);
          const noteText =
            queued.length === 1
              ? queued[0]
              : queued.map((t, i) => `(${i + 1}) ${t}`).join('\n\n');
          for (const t of queued) {
            onEv({ type: 'interrupt_picked_up', sessionId, text: t });
          }
          const queuedUserMsg: Anthropic.MessageParam = {
            role: 'user',
            content: noteText,
          };
          messages.push(queuedUserMsg);
          appendJsonlEvent(ourPath, {
            type: 'user',
            uuid: randomUUID(),
            sessionId,
            cwd,
            message: { role: 'user', content: noteText },
          });
          log.info(
            `[agent] turn-end picked up ${queued.length} queued message(s) for ${sessionId}; continuing`
          );
          continue;
        }

        // No queued input either — the turn is genuinely done. We deliberately
        // go to `waiting-on-user` here (NOT idle) so the session keeps
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
      // Set when a tool returns `sleepUntil`. The agent loop exits
      // cleanly after the current tool's result is recorded, persists
      // the session as `sleeping-tool` (the tool already did the state
      // write — this is just an exit signal), and arms the wake timer.
      let sleepingUntil: number | null = null;
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
          // ---- Context-bail interception -----------------------------
          //
          // If the WaitForUser question matches the "should I stop or
          // keep going due to context budget / fresh session pickup"
          // anti-pattern, refuse it. Context management is automatic
          // (server-side micro-compaction + client-side preflight); the
          // user has explicitly said they never want to be asked these
          // questions. Synthesize a tool_result that nudges the model
          // to keep working and continue the loop instead of breaking.
          //
          // Bounded by `MAX_CONTEXT_BAIL_NUDGES` so a genuinely confused
          // model eventually falls through to a real WaitForUser (better
          // UX to surface the bug than to silently hang the session in
          // a refusal loop forever).
          if (
            contextBailNudgesUsed < MAX_CONTEXT_BAIL_NUDGES &&
            looksLikeContextBail(question)
          ) {
            contextBailNudgesUsed++;
            const nudgeMsg = buildContextBailNudge(
              contextBailNudgesUsed,
              MAX_CONTEXT_BAIL_NUDGES
            );
            log.warn(
              `[agent] context-bail WaitForUser intercepted for ${sessionId} ` +
                `(nudge ${contextBailNudgesUsed}/${MAX_CONTEXT_BAIL_NUDGES}): ` +
                `${question.slice(0, 160)}`
            );
            // Push a tool_result so the conversation history is well-
            // formed for the NEXT streamMessage call. The model sees
            // the refusal as a tool_result response to its own
            // WaitForUser call — same shape as a normal tool, with
            // is_error=true to make the refusal visually distinct.
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: nudgeMsg,
              is_error: true,
            } as any);
            // Surface in the UI's tool-card row as an error result so
            // the user can see the guardrail fired (no silent magic).
            // We DO NOT emit `wait_for_user` — the session stays in
            // its current `running` state and the loop continues.
            onEv({
              type: 'tool_result',
              sessionId,
              id: tu.id,
              content: 'Context-bail WaitForUser refused — guardrail nudged model to keep working.',
              isError: true,
              ms: 0,
            });
            // Don't break — keep executing any remaining tools in this
            // batch and then re-stream so the model gets the nudge.
            continue;
          }
          // ---- WaitForUser auto-pickup of queued interrupts ----------
          //
          // If the user typed a message while the previous round was
          // running and that message is still sitting in the interrupt
          // queue, treat it as the answer to this WaitForUser instead
          // of transitioning the session to "waiting-on-user".
          //
          // Without this special case the session would land in "needs
          // you" state with the user's already-typed answer sitting
          // unread in the queue (the post-tool-loop drainInterrupts
          // would still append it, but the turn ends with
          // `wait_for_user` so the next streamMessage never fires —
          // the user has to type ANOTHER message to make the session
          // pick up the queue, which is confusing and undesired).
          //
          // Behavior:
          //   • Drain the queue.
          //   • Synthesize a tool_result whose content IS the user's
          //     message (joined if multiple). This matches the
          //     contract of WaitForUser — its tool_result IS the user's
          //     answer, fed into the next assistant turn.
          //   • Mirror the messages as `interrupt_picked_up` events so
          //     the chat shows them as user bubbles (otherwise they'd
          //     be invisible).
          //   • Do NOT set state=waiting-on-user, do NOT emit
          //     wait_for_user, do NOT set waitedForUser.
          //   • `continue` — let the for-loop fall through and the
          //     post-loop drain (which now finds an empty queue) ride
          //     to the next streamMessage iteration.
          if (peekInterrupts(sessionId) > 0) {
            const drained = drainInterrupts(sessionId);
            const answer =
              drained.length === 1
                ? drained[0]
                : drained.map((t, i) => `(${i + 1}) ${t}`).join('\n\n');
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: answer,
            });
            for (const t of drained) {
              onEv({ type: 'interrupt_picked_up', sessionId, text: t });
            }
            log.info(
              `[agent] WaitForUser auto-answered from ${drained.length} queued interrupt(s) for ${sessionId}`
            );
            // Same UI shape we'd give a normal tool_result so the
            // tool card resolves cleanly. Use the question as the
            // input-display so the user can see what they answered.
            onEv({
              type: 'tool_result',
              sessionId,
              id: tu.id,
              content: `Auto-answered from queued message: ${answer.slice(0, 200)}${answer.length > 200 ? '…' : ''}`,
              isError: false,
              ms: 0,
            });
            // Keep going — there might be more tool_uses in the batch
            // (rare for WaitForUser, but possible) and we want the
            // post-loop logic to ride to the next streamMessage.
            continue;
          }
          // ---- Normal WaitForUser path -------------------------------
          //
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
        const raw = await executeTool(tu.name, tu.input, {
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
        // Two-track output:
        //   • `content` (string or content-block array) → the model, via
        //     the next tool_result on the wire.
        //   • `uiSummary` (always a string) → the renderer's tool-call
        //     card AND our audit log.
        // For 99% of tools these are identical. The exception is
        // BrowserScreenshot, which returns a content-block array
        // carrying the actual image bytes; its uiSummary is a short
        // line like "Screenshot taken — 12 elements labeled" so the
        // UI doesn't have to choke on a 200KB base64 in a div.
        let content: string | Array<unknown> = raw.content;
        let uiSummary: string = raw.uiSummary;
        let isError = raw.isError;

        // Tool result summarization only applies when the model-facing
        // content is a plain string. Large Bash dumps, big Reads, and
        // sprawling Greps get archived to disk and replaced with a
        // head+tail+stats summary the model sees instead. The original
        // is recoverable via Read on the archive path embedded in the
        // summary. We deliberately skip this path for structured
        // (image-bearing) results: there's nothing to summarize, and
        // the image is the whole point.
        if (typeof content === 'string') {
          const summarized = maybeSummarize({
            toolName: tu.name,
            toolInput: tu.input,
            sessionId,
            toolUseId: tu.id,
            rawContent: content,
            isError,
          });
          content = summarized.content;
          uiSummary = summarized.content;
          isError = summarized.isError;
          if (summarized.archivePath) {
            log.info(
              `[agent] tool=${tu.name} archived ${summarized.originalChars.toLocaleString()} chars to ${summarized.archivePath}`
            );
          }
        }
        // Audit row for this tool call. We use uiSummary because the
        // audit DB is sized for short text rows, not image base64.
        try {
          insertAuditEvent({
            ts: start,
            projectId,
            sessionId,
            tool: tu.name,
            inputJson: safeStringify(tu.input),
            outputRef:
              uiSummary.length > 256 ? uiSummary.slice(0, 256) + '…' : uiSummary,
            status: isError ? 'error' : 'ok',
            durationMs: ms,
          });
        } catch (e) {
          log.warn('[agent] audit insert failed', e);
        }
        // Tool may have flipped state to waiting-on-system mid-execution
        // (e.g. WaitFor*); reset to running for the next iteration.
        //
        // EXCEPTION: a tool with `sleepUntil` is a persistent-sleep tool
        // (today only WaitForTime). It already set state=sleeping-tool
        // and wake_at_ts; flipping back to `running` would (a) clobber
        // the sleeping-tool state the sidebar needs to surface and (b)
        // un-pause a session the user explicitly told to wait. Leave
        // the tool's state write in place.
        if (raw.sleepUntil) {
          log.info(
            `[agent] session ${sessionId} entering sleeping-tool (wake at ${new Date(raw.sleepUntil).toISOString()})`
          );
        } else {
          setSessionState(sessionId, 'running');
          broadcastStateChanged(sessionId, 'running');
        }
        // If the result carries image blocks (ShowImage, AppScreenshot,
        // BrowserScreenshot, etc.), forward them to the renderer so the USER
        // sees the picture too - not just the model. uiSummary stays a short
        // string for the card header / audit; the images render below it.
        let images: Array<{ media_type: string; data: string }> | undefined;
        if (Array.isArray(content)) {
          const imgs = (content as any[])
            .filter((b) => b && b.type === 'image' && b.source?.type === 'base64')
            .map((b) => ({ media_type: b.source.media_type as string, data: b.source.data as string }));
          if (imgs.length > 0) images = imgs;
        }
        onEv({
          type: 'tool_result',
          sessionId,
          id: tu.id,
          content: uiSummary,
          isError,
          ms,
          ...(images ? { images } : {}),
        });
        const block: any = {
          type: 'tool_result',
          tool_use_id: tu.id,
          content,
        };
        if (isError) block.is_error = true;
        toolResultBlocks.push(block);

        // Persistent-sleep handoff. The tool already wrote state +
        // wake_at_ts; we just need to synthesize skip results for any
        // tools later in the same batch (the model shouldn't expect
        // them to have executed) and break out of the for-loop. The
        // outer while-loop detects `sleepingUntil` after writing the
        // user message to JSONL and exits the turn cleanly.
        if (raw.sleepUntil) {
          sleepingUntil = raw.sleepUntil;
          for (let j = toolIdx + 1; j < toolUses.length; j++) {
            const skip = toolUses[j];
            // WaitForUser after a sleeping tool is nonsensical, but
            // if the model emitted one we still need a well-formed
            // tool_result so the next API call doesn't 400.
            toolResultBlocks.push({
              type: 'tool_result',
              tool_use_id: skip.id,
              content: '(skipped — session is sleeping; will resume at wake time)',
            });
            onEv({
              type: 'tool_result',
              sessionId,
              id: skip.id,
              content: '(skipped — session sleeping)',
              isError: false,
              ms: 0,
            });
          }
          if (toolUses.length - (toolIdx + 1) > 0) {
            log.info(
              `[agent] sleeping-tool: skipped ${toolUses.length - (toolIdx + 1)} subsequent tool(s) in the batch for ${sessionId}`
            );
          }
          break;
        }
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
      if (sleepingUntil != null) {
        // The persistent-sleep tool (WaitForTime) ran in this batch.
        // The user message carrying its tool_result (and any skip
        // results for subsequent tools) has just been written to
        // JSONL above, so the conversation history is well-formed
        // for the future wake. Arm an in-process wake timer (so the
        // resume is snappy if the app stays alive) and exit the
        // turn cleanly — DON'T loop back to streamMessage. The
        // governor's sweep is the durable backup if the timer is
        // lost to a restart before wake.
        armWakeTimer(sessionId, sleepingUntil);
        onEv({ type: 'turn_done', sessionId, stopReason: 'sleeping-tool' });
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
      // Translate raw "prompt is too long" 400s into something the
      // user can actually do something about. Pre-flight + emergency
      // compact catch the vast majority of these; reaching the outer
      // catch means the session has so much un-compactable content
      // (e.g. one giant attachment that even ephemeralization can't
      // shrink, or a tail that's already minimal) that no automated
      // strategy works. Tell the user to fork.
      const ptl = isPromptTooLongError(e);
      let message: string;
      if (ptl.hit) {
        message =
          `Context overflow: this turn would have sent ${ptl.tokens.toLocaleString()} tokens, ` +
          `over the model's input cap. The auto-compactor couldn't shrink the conversation enough ` +
          `to fit. To continue, start a new session — your existing JSONL is preserved on disk and ` +
          `can be re-opened later. You can also try a shorter follow-up message; if your last user ` +
          `message contained large attachments, removing them may be enough on its own.`;
      } else {
        // Anthropic SDK / transport errors (5xx, auth, rate-limit, etc.)
        // get user-facing rephrasing via `classifyApiError`. The raw
        // message ("500 status code (no body)") is technically accurate
        // but unhelpful — the classifier wraps it with "this is
        // transient, try again in a minute" or "check your key in
        // Settings" or whatever's appropriate. See `electron/apiErrors.ts`.
        message = classifyApiError(e).message;
      }
      onEv({
        type: 'error',
        sessionId,
        message,
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
