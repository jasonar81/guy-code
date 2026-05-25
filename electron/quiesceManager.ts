/**
 * Quiesce manager: drain in-flight agent turns before quitting.
 *
 * Used by the auto-update install flow: when the user clicks
 * "Restart to install" on the update banner, we don't want to
 * kill the agent process mid-stream. The model is in the middle
 * of a turn, possibly mid-tool-call, and a hard quit would:
 *
 *   • Lose the streamed-but-not-flushed assistant text.
 *   • Leave a tool_use block with no matching tool_result in
 *     the JSONL, which the resume logic in `sessionRuntime.ts`
 *     would then have to repair as if it were a crash.
 *   • Burn the model's spend on tokens we never see.
 *
 * Quiescent states (safe to quit):
 *   • idle              — nothing happening.
 *   • waiting-on-user   — the model paused for user input via
 *                          WaitForUser; no in-flight API call.
 *   • sleeping-budget   — paused waiting for budget rollover; no
 *                          in-flight API call.
 *   • error             — already failed; nothing in flight.
 *   • done              — turn completed cleanly.
 *
 * Active states (NOT safe to quit; we wait):
 *   • running              — agent loop is mid-iteration.
 *   • waiting-on-system    — tool execution in flight (BashRun, etc.).
 *
 * Strategy: poll session states every POLL_INTERVAL_MS until either
 * (a) all sessions are quiescent, or (b) DRAIN_TIMEOUT_MS elapses.
 * Timeout is the IPC handler's responsibility to surface — we just
 * reject the promise so the caller can prompt "drain timed out;
 * install anyway?"
 *
 * Future expansion (NOT IN SCOPE FOR v1):
 *   • A "graceful drain" mode that signals the agent loop to stop
 *     at the next round boundary (after the current tool_result
 *     processes) instead of waiting for natural completion. This
 *     would shorten the typical drain time from "next turn done"
 *     (could be many minutes) to "next round done" (typically
 *     seconds). For v1 we just wait — most update scenarios will
 *     find sessions already idle.
 *
 * The manager is a pure function over the DB. It doesn't keep its
 * own state; every check re-queries `sessions` so a session that
 * transitions naturally during the drain window is detected
 * immediately.
 */

import log from 'electron-log';
import { listSessionsByState } from './db';

/**
 * Maximum time to wait for sessions to drain before giving up.
 * 30 s matches user expectations for "click Restart, app comes back
 * shortly." Longer than this and the perceived UX is "it's stuck."
 *
 * Most real installs find all sessions already idle (the user clicked
 * Restart while reading, not mid-stream). The timeout matters for
 * the edge case where one session is mid-Bash-build.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Poll cadence. 250 ms is responsive enough to feel snappy without
 * burning CPU on the SQLite query during the wait.
 */
const POLL_INTERVAL_MS = 250;

/**
 * Session states that are NOT safe to quit during. Any session in
 * one of these states blocks the drain.
 */
const ACTIVE_STATES = ['running', 'waiting-on-system'];

/**
 * Returns the list of session IDs currently in an active state.
 * Empty list means safe to quit.
 */
export function listActiveSessionIds(): string[] {
  const ids: string[] = [];
  for (const state of ACTIVE_STATES) {
    const rows = listSessionsByState(state);
    for (const r of rows) ids.push(r.id);
  }
  return ids;
}

/**
 * Wait for all sessions to reach a quiescent state.
 *
 * Resolves with the elapsed wait time (ms) when the drain completes
 * cleanly. Rejects with an Error if the timeout elapses with at
 * least one session still active — the error message lists the
 * stuck session IDs so the caller (or user prompt) can decide
 * whether to force-install.
 *
 * @param opts.timeoutMs Override the default 30 s timeout. Set to
 *   a small number in tests; pass a larger value if you have a
 *   reason to wait through a known-long Bash build.
 */
export function drainBeforeQuit(
  opts: { timeoutMs?: number } = {}
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<number>((resolve, reject) => {
    const tick = () => {
      const active = listActiveSessionIds();
      if (active.length === 0) {
        const elapsed = Date.now() - startedAt;
        log.info(`[quiesce] drain complete after ${elapsed}ms`);
        resolve(elapsed);
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        const stuck = active.map((id) => id.slice(0, 8)).join(', ');
        log.warn(
          `[quiesce] drain timed out after ${elapsed}ms with ${active.length} ` +
            `session(s) still active: ${stuck}`
        );
        reject(
          new Error(
            `${active.length} session(s) still active after ${elapsed}ms ` +
              `(stuck: ${stuck}). Force-install would lose in-flight work.`
          )
        );
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };
    tick();
  });
}

/**
 * Synchronous "are we currently drainable?" check. Useful for the
 * UpdateBanner UI to disable the Restart button until quiescent —
 * less surprising than letting the user click and then watching a
 * 30s spinner.
 */
export function isDrainable(): boolean {
  return listActiveSessionIds().length === 0;
}
