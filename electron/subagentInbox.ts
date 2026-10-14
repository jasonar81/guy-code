/**
 * Messages the user sends TO A RUNNING SUBAGENT.
 *
 * THE PROBLEM. A subagent runs synchronously inside the parent's turn: the
 * parent is parked inside the Task/Plan/Execute/Review tool call until the
 * child finishes. Anything typed meanwhile goes to the parent's interrupt
 * queue, which is only drained by the PARENT loop - so it sits there, unread,
 * until the subagent is done. If the child is heading the wrong way you can
 * only watch.
 *
 * THE FIX. A second queue, drained by the subagent between its own rounds and
 * injected as a user message, so mid-run steering actually reaches the thing
 * doing the work. The existing parent queue is untouched; the user chooses
 * which one a message goes to.
 *
 * Keyed by sessionId because that is what the UI knows. Nested subagents are
 * not possible (a child cannot spawn another), so at most one subagent is
 * active per session and the key is unambiguous.
 */
import log from 'electron-log';

/** sessionId -> queued messages for the subagent currently running there. */
const _inbox = new Map<string, string[]>();

/** sessionId -> metadata about the subagent currently running, if any. */
const _active = new Map<string, { runId: string; role: string; description: string }>();

/** Record that a subagent has started, so the UI can offer to message it. */
export function markSubagentActive(
  sessionId: string,
  info: { runId: string; role: string; description: string }
): void {
  _active.set(sessionId, info);
}

/**
 * Record that the subagent finished. Any messages still queued for it are
 * RETURNED so the caller can hand them back to the parent rather than drop
 * them - a message the user sent a moment too late should still be read.
 */
export function markSubagentDone(sessionId: string): string[] {
  _active.delete(sessionId);
  const leftovers = _inbox.get(sessionId) ?? [];
  _inbox.delete(sessionId);
  return leftovers;
}

/** The subagent running in this session, or null. */
export function activeSubagent(
  sessionId: string
): { runId: string; role: string; description: string } | null {
  return _active.get(sessionId) ?? null;
}

/**
 * Queue a message for the running subagent. Returns the new queue length, or
 * -1 when no subagent is running (the caller should fall back to the parent
 * queue rather than silently swallow the text).
 */
export function sendToSubagent(sessionId: string, text: string): number {
  const t = (text ?? '').trim();
  if (!t) return _inbox.get(sessionId)?.length ?? 0;
  if (!_active.has(sessionId)) return -1;
  const cur = _inbox.get(sessionId) ?? [];
  cur.push(t);
  _inbox.set(sessionId, cur);
  log.info(`[subagentInbox] queued message for subagent in ${sessionId} (${cur.length} pending)`);
  return cur.length;
}

/** Read-and-clear the subagent's queue. FIFO. */
export function drainSubagentInbox(sessionId: string): string[] {
  const cur = _inbox.get(sessionId);
  if (!cur || cur.length === 0) return [];
  _inbox.delete(sessionId);
  return cur;
}

/** How many messages are waiting for the subagent (for the UI badge). */
export function peekSubagentInbox(sessionId: string): number {
  return _inbox.get(sessionId)?.length ?? 0;
}

/** Test seam: forget everything. */
export function resetSubagentInbox(): void {
  _inbox.clear();
  _active.clear();
}
