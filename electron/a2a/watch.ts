/**
 * The watch extension runner (design 5.5, `https://ocient.dev/a2a/ext/watch/v1`).
 *
 * "Have Dylan's agent tell us when his ja-sql1 test is done" must not depend
 * on Dylan's model remembering to report back three hours later, and must not
 * cost a model call every few minutes while it waits. So when Dylan's agent
 * accepts the notify task it calls `A2AReply action=watch` with a check
 * command it writes itself (for example `! pgrep -f bench_p5.py`), and Guy
 * Code's own runtime polls that command:
 *
 *   - every `intervalMs` it runs the check through the SAME shell handling as
 *     WaitForCondition (`runConditionCheck` in tools.ts, injected as
 *     `WatchCheckFn` so this file stays Electron-free and testable);
 *   - exit 0 = met. `onMet:"complete"` completes the task with an artifact
 *     (command, exit code, last 20 output lines) and pushes it, with NO model
 *     call at all. `onMet:"wake"` hands a note to the owning session so the
 *     agent writes a proper summary and completes the task itself;
 *   - non-zero = not yet; run again after `intervalMs`;
 *   - three launch failures in a row (the shell or command cannot even
 *     start) = FAILED with that reason, rather than looping for days;
 *   - past `deadlineTs` = FAILED with "did not become true within ...".
 *
 * Persistence mirrors WaitForCondition: the state lives in
 * `a2a_tasks.watch_json` and the next run time in `a2a_tasks.watch_next_ts`
 * (migration v16). An in-process timer gives the low-latency path; the node
 * sweeps on start and the budget governor's 60 s sweep calls `sweep()` too,
 * so a watch survives an app restart and a laptop suspend.
 *
 * SECURITY (design 5.5): the command is authored by the LOCAL agent through
 * the A2AReply tool and nothing else. A requester may send a hint in the
 * message metadata, but that is display text for the local model and user.
 * This module never sees the inbound message: `WatchState` is built only from
 * the explicit tool arguments in `buildWatchState`, and the only string ever
 * handed to the check function is `WatchState.command`. tests/a2a/watch.test.ts
 * pins both the behaviour and the absence of any route from the message here.
 */

export type WatchShell = 'powershell' | 'bash';
export type WatchOnMet = 'complete' | 'wake';

/** Stored in `a2a_tasks.watch_json`. */
export interface WatchState {
  /** Random id: a stale tick for a replaced or cancelled watch is discarded. */
  id: string;
  command: string;
  shell: WatchShell;
  cwd: string;
  intervalMs: number;
  deadlineTs: number;
  onMet: WatchOnMet;
  startedTs: number;
  /** Local session that installed it; `onMet:"wake"` wakes this one. */
  sessionId: string | null;
  /** Consecutive runs where the check could not even launch. */
  launchFailures: number;
  checks: number;
  lastCode: number | null;
}

/** What runConditionCheck returns (tools.ts), plus the captured output tail. */
export interface WatchCheckResult {
  code: number;
  launched: boolean;
  detail?: string;
  output?: string;
}
export type WatchCheckFn = (command: string, cwd: string, shell: WatchShell, timeoutMs: number) => Promise<WatchCheckResult>;

export const WATCH_LIMITS = {
  minIntervalMs: 1_000,
  maxIntervalMs: 24 * 3_600_000,
  defaultIntervalMs: 60_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 30 * 24 * 3_600_000,
  defaultTimeoutMs: 4 * 3_600_000,
  maxCommandChars: 2_000,
  /** Per-run cap, the same as WaitForCondition's. */
  checkTimeoutMs: 60_000,
  /** Launch failures in a row before giving up (agent.ts uses the same 3). */
  maxLaunchFailures: 3,
  artifactLines: 20,
} as const;

function clampInt(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/**
 * Validate A2AReply's watch arguments into a stored state. Throws plain
 * English for the model. Takes ONLY the tool's own arguments: there is
 * deliberately no parameter through which inbound message content could
 * arrive.
 */
export function buildWatchState(
  a: { command: unknown; shell?: unknown; intervalMs?: unknown; timeoutMs?: unknown; onMet?: unknown; cwd: string; sessionId: string | null },
  now: number,
  id: string,
  platform: string = process.platform
): WatchState {
  const command = typeof a.command === 'string' ? a.command.trim() : '';
  if (!command) {
    throw new Error('action "watch" needs a `command` you write yourself: a shell check that exits 0 when the event has happened (for example `! pgrep -f bench_p5.py` once the test process is gone).');
  }
  if (command.length > WATCH_LIMITS.maxCommandChars) throw new Error(`The check command is too long (max ${WATCH_LIMITS.maxCommandChars} characters). Put the logic in a script and call that.`);
  const shell: WatchShell = a.shell === 'bash' || a.shell === 'powershell' ? a.shell : platform === 'win32' ? 'powershell' : 'bash';
  if (a.onMet !== undefined && a.onMet !== null && a.onMet !== '' && a.onMet !== 'complete' && a.onMet !== 'wake') {
    throw new Error('onMet must be "complete" (report the check output, no AI) or "wake" (wake you to write a summary).');
  }
  const onMet: WatchOnMet = a.onMet === 'wake' ? 'wake' : 'complete';
  const intervalMs = clampInt(a.intervalMs, WATCH_LIMITS.minIntervalMs, WATCH_LIMITS.maxIntervalMs, WATCH_LIMITS.defaultIntervalMs);
  const timeoutMs = clampInt(a.timeoutMs, WATCH_LIMITS.minTimeoutMs, WATCH_LIMITS.maxTimeoutMs, WATCH_LIMITS.defaultTimeoutMs);
  return {
    id,
    command,
    shell,
    cwd: a.cwd,
    intervalMs,
    deadlineTs: now + timeoutMs,
    onMet,
    startedTs: now,
    sessionId: a.sessionId,
    launchFailures: 0,
    checks: 0,
    lastCode: null,
  };
}

export function parseWatchState(json: string | null | undefined): WatchState | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as WatchState;
    return s && typeof s.command === 'string' && typeof s.deadlineTs === 'number' && typeof s.id === 'string' ? s : null;
  } catch {
    return null;
  }
}

export type TickDecision =
  | { kind: 'met'; state: WatchState }
  | { kind: 'again'; state: WatchState; nextTs: number }
  | { kind: 'timeout' | 'broken'; state: WatchState; reason: string };

/** "12m31s", "4h", "2d3h". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) return `${d}d${h ? `${h}h` : ''}`;
  if (h) return `${h}h${m ? `${m}m` : ''}`;
  if (m) return `${m}m${sec ? `${sec}s` : ''}`;
  return `${sec}s`;
}

/** What one check run means for the watch. Pure; mirrors agent.ts's WaitForCondition branch. */
export function decideTick(s: WatchState, r: WatchCheckResult, now: number): TickDecision {
  const checks = s.checks + 1;
  if (r.launched && r.code === 0) return { kind: 'met', state: { ...s, checks, lastCode: 0, launchFailures: 0 } };
  if (!r.launched) {
    const fails = s.launchFailures + 1;
    const next = { ...s, checks, launchFailures: fails };
    const why = r.detail ?? `exit ${r.code}`;
    if (fails >= WATCH_LIMITS.maxLaunchFailures) {
      return { kind: 'broken', state: next, reason: `Stopped watching: the check command could not run ${fails} times in a row (${why}).` };
    }
    if (now >= s.deadlineTs) {
      return { kind: 'timeout', state: next, reason: `Stopped watching: the condition did not become true within ${fmtDuration(s.deadlineTs - s.startedTs)}, and the last check could not run (${why}).` };
    }
    return { kind: 'again', state: next, nextTs: Math.min(now + s.intervalMs, s.deadlineTs) };
  }
  const next = { ...s, checks, lastCode: r.code, launchFailures: 0 };
  if (now < s.deadlineTs) return { kind: 'again', state: next, nextTs: Math.min(now + s.intervalMs, s.deadlineTs) };
  return {
    kind: 'timeout',
    state: next,
    reason: `Stopped watching: the condition did not become true within ${fmtDuration(s.deadlineTs - s.startedTs)} (checked ${checks} time${checks === 1 ? '' : 's'}; the last check exited ${r.code}).`,
  };
}

/**
 * Mask the obvious secret shapes before a command or its output leaves this
 * machine (artifact) or reaches the audit log. A backstop, like audit.redact:
 * a check command should not contain secrets in the first place.
 */
export function maskSecrets(s: string): string {
  return String(s ?? '')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]')
    .replace(/(-p\s*|--password[= ])\S+/g, '$1[redacted]')
    .replace(/(https?:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1[redacted]@');
}

/** The last `n` non-empty-at-the-end lines of the captured output. */
export function lastLines(output: string | undefined, n: number = WATCH_LIMITS.artifactLines): string[] {
  const lines = String(output ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-n).map((l) => (l.length > 500 ? l.slice(0, 497) + '...' : l));
}

/** The COMPLETED artifact for onMet "complete" (design 5.5): command, exit code, last 20 lines. */
export function metArtifactParts(s: WatchState, r: WatchCheckResult, now: number): Array<{ text?: string; data?: unknown }> {
  const command = maskSecrets(s.command);
  const lines = lastLines(r.output).map(maskSecrets);
  const head = `Condition met: the check \`${command}\` exited ${r.code} (after ${s.checks} check${s.checks === 1 ? '' : 's'} over ${fmtDuration(now - s.startedTs)}).`;
  const body = lines.length ? `\nLast ${lines.length} line${lines.length === 1 ? '' : 's'} of output:\n${lines.join('\n')}` : '\n(The check printed nothing.)';
  return [
    { text: head + body },
    { data: { event: 'watch_met', command, exitCode: r.code, lastLines: lines, checks: s.checks, elapsedMs: now - s.startedTs } },
  ];
}

/** The note that wakes the local agent for onMet "wake". */
export function wakeNote(s: WatchState, r: WatchCheckResult, task: { taskId: string; peerId: string; summary: string | null }): string {
  const lines = lastLines(r.output);
  const what = task.summary ? ` ("${task.summary.replace(/\s+/g, ' ').slice(0, 100)}")` : '';
  return (
    `[A2A watch] The check you set up for ${task.peerId}'s task ${task.taskId.slice(0, 8)}${what} is met: \`${s.command}\` exited ${r.code}.` +
    (lines.length ? `\nLast ${lines.length} line${lines.length === 1 ? '' : 's'} of output:\n${lines.join('\n')}` : '') +
    `\nWrite a short summary of the outcome for ${task.peerId}'s agent and send it with A2AReply, taskId "${task.taskId}", action "complete". Tell your user in one line.`
  );
}

/** What the runner needs from its owner (the A2ANode). */
export interface WatchHost {
  /** Every open task with a watch, and when it next runs. */
  list(): Array<{ taskId: string; state: WatchState; nextTs: number }>;
  get(taskId: string): { state: WatchState; nextTs: number } | null;
  check: WatchCheckFn;
  /**
   * Apply a tick's decision (DB write, state change, push). Returns false
   * when the watch was replaced or stopped meanwhile and the decision was
   * discarded.
   */
  apply(taskId: string, ran: WatchState, d: TickDecision, r: WatchCheckResult): boolean;
  now(): number;
}

/** Node's setTimeout overflows past ~24.8 days; hop at most a day at a time (as armWakeTimer does). */
const MAX_TIMER_HOP_MS = 24 * 3_600_000;

export class WatchRunner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inflight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly host: WatchHost,
    private readonly opts: { timers: boolean }
  ) {}

  /** (Re)arm the in-process timer for one watch. No-op when timers are off (tests drive `sweep`). */
  arm(taskId: string, nextTs: number): void {
    if (!this.opts.timers || this.stopped) return;
    this.clearTimer(taskId);
    const remaining = Math.max(0, nextTs - this.host.now());
    const capped = remaining > MAX_TIMER_HOP_MS;
    const t = setTimeout(() => {
      this.timers.delete(taskId);
      if (capped) {
        this.arm(taskId, nextTs);
        return;
      }
      void this.runNow(taskId);
    }, Math.min(remaining, MAX_TIMER_HOP_MS));
    t.unref?.();
    this.timers.set(taskId, t);
  }

  private clearTimer(taskId: string): void {
    const t = this.timers.get(taskId);
    if (t) clearTimeout(t);
    this.timers.delete(taskId);
  }

  /** Forget a watch's timer (the task finished, was cancelled, or the watch was replaced). */
  cancel(taskId: string): void {
    this.clearTimer(taskId);
  }

  stopAll(): void {
    this.stopped = true;
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  start(): void {
    this.stopped = false;
  }

  armedCount(): number {
    return this.timers.size;
  }

  /**
   * Run everything that is due now and arm the rest. Called on node start
   * (restart survival) and by the governor sweep. Resolves when the due
   * checks have finished.
   */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    const now = this.host.now();
    const runs: Promise<void>[] = [];
    for (const w of this.host.list()) {
      if (this.inflight.has(w.taskId)) {
        runs.push(this.inflight.get(w.taskId)!);
        continue;
      }
      if (w.nextTs <= now) runs.push(this.runNow(w.taskId));
      else if (!this.timers.has(w.taskId)) this.arm(w.taskId, w.nextTs);
    }
    await Promise.all(runs);
  }

  /** Run one watch's check now. Concurrent calls for the same task share one run. */
  runNow(taskId: string): Promise<void> {
    const running = this.inflight.get(taskId);
    if (running) return running;
    this.clearTimer(taskId);
    const p = (async () => {
      const w = this.host.get(taskId);
      if (!w || this.stopped) return;
      let r: WatchCheckResult;
      try {
        r = await this.host.check(w.state.command, w.state.cwd, w.state.shell, WATCH_LIMITS.checkTimeoutMs);
      } catch (e) {
        r = { code: 125, launched: false, detail: (e as Error).message };
      }
      // Stopped meanwhile (A2A turned off, app quitting): leave the stored
      // state alone so the next start re-runs this check.
      if (this.stopped) return;
      const d = decideTick(w.state, r, this.host.now());
      if (this.host.apply(taskId, w.state, d, r) && d.kind === 'again') this.arm(taskId, d.nextTs);
    })();
    const guarded = p.finally(() => {
      if (this.inflight.get(taskId) === guarded) this.inflight.delete(taskId);
    });
    this.inflight.set(taskId, guarded);
    return guarded;
  }
}
