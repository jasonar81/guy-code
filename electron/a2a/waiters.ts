/**
 * WaitForA2A bookkeeping and wake decisions (design 6.4).
 *
 * "Have Dylan's agent tell us when his test is done, then run our perf test"
 * must cost nothing while Dylan's test runs, survive Guy Code restarting, and
 * still finish if a push is lost. So a waiting session is just a DB row
 * (`sessions.wait_a2a` + `wake_at_ts`, state `sleeping-tool`) and three
 * things can wake it, none of which calls the model unless the wait is over:
 *
 *   1. Push path. `/a2a-push` updates the task, then `onTaskEvent` scans the
 *      waiting sessions. A match (default: the task reached a terminal state,
 *      needs input, or the peer sent a new message) clears the wait and
 *      resumes the session with a one-line note such as
 *      `[WaitForA2A] dylan's task 9b21 "notify when ja-sql1 test done" -> COMPLETED: ...`.
 *      A WORKING update does not match, so the session keeps sleeping.
 *   2. Timer path. `wake_at_ts` is min(deadline, now + 10 minutes). When it
 *      fires (in-process timer, or the governor sweep after a restart),
 *      agent.ts asks `checkWait` what to do: it polls GET /tasks/{id} for any
 *      task with no news for 10 minutes (the backstop for lost pushes and for
 *      peers that do not push), then either resumes or re-sleeps. No model call.
 *   3. Subagents. They have no session row, so `waitInProcess` blocks inside
 *      the parent turn, woken by the same events and polling every 30s.
 *
 * An INPUT_REQUIRED that only means "the other user has not approved it yet"
 * does NOT wake a default wait. Waking the model to be told "still waiting
 * for Dylan" would be exactly the spend this design exists to avoid.
 *
 * Electron-free: session access goes through `WaitPort`.
 */
import { TERMINAL_STATES, type TaskState } from './types';

/** Stored in `sessions.wait_a2a` as JSON. */
export interface WaitA2AState {
  /** Full task ids (OUT tasks). Empty means "any task matching peer / contextId". */
  taskIds: string[];
  peer: string | null;
  contextId: string | null;
  /** Explicit states to wake on, or null for the default set (see `stateWakes`). */
  states: TaskState[] | null;
  deadlineTs: number;
  pollStaleMs: number;
  startedTs: number;
}

/** One change on a task, or a new agent message on it. */
export interface A2ATaskEvent {
  taskId: string;
  peerId: string;
  contextId: string | null;
  direction: 'in' | 'out';
  state: TaskState;
  /** 'message' = a new agent message on the task, state unchanged. */
  kind: 'state' | 'message';
  /** INPUT_REQUIRED that only means "waiting for the other user to approve". */
  approvalPending?: boolean;
  summary?: string | null;
  /** Status message / artifact / message text, for the resume note. */
  text?: string;
}

export const POLL_STALE_MS = 10 * 60_000;
export const SUBAGENT_POLL_MS = 30_000;
export const MAX_WAIT_MS = 30 * 24 * 60 * 60_000;

export function stateWord(s: string): string {
  return String(s ?? '').replace(/^TASK_STATE_/, '');
}

/** Accept "COMPLETED", "completed" or "TASK_STATE_COMPLETED". */
export function normaliseState(s: unknown): TaskState | null {
  const v = String(s ?? '').trim().toUpperCase();
  if (!v) return null;
  const full = v.startsWith('TASK_STATE_') ? v : `TASK_STATE_${v}`;
  const ok = ['SUBMITTED', 'WORKING', 'INPUT_REQUIRED', 'AUTH_REQUIRED', 'COMPLETED', 'FAILED', 'CANCELED', 'REJECTED'];
  return ok.includes(full.slice('TASK_STATE_'.length)) ? (full as TaskState) : null;
}

/** Does this state end a wait with the given `states` setting? */
export function stateWakes(states: TaskState[] | null, state: TaskState, approvalPending = false): boolean {
  if (states && states.length) return states.includes(state);
  if (TERMINAL_STATES.has(state)) return true;
  return state === 'TASK_STATE_INPUT_REQUIRED' && !approvalPending;
}

/** Is this event inside the wait's scope (task / peer / context)? */
export function inScope(w: Pick<WaitA2AState, 'taskIds' | 'peer' | 'contextId'>, on: { taskId?: string | null; peerId: string; contextId?: string | null }): boolean {
  if (w.taskIds.length) {
    if (!on.taskId || !w.taskIds.includes(on.taskId)) return false;
  }
  if (w.peer && w.peer !== on.peerId) return false;
  if (w.contextId && w.contextId !== on.contextId) return false;
  return w.taskIds.length > 0 || !!w.peer || !!w.contextId;
}

export function eventWakes(w: WaitA2AState, ev: A2ATaskEvent): boolean {
  if (ev.direction !== 'out') return false;
  if (!inScope(w, ev)) return false;
  if (ev.kind === 'message') return !w.states || w.states.length === 0;
  return stateWakes(w.states, ev.state, ev.approvalPending);
}

function clip(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
}

export function resumeNote(ev: A2ATaskEvent): string {
  const what = ev.summary ? ` "${clip(ev.summary, 80)}"` : '';
  const head = `[WaitForA2A] ${ev.peerId}'s task ${ev.taskId.slice(0, 8)}${what}`;
  const body = ev.text ? `: "${clip(ev.text, 1500)}"` : '';
  if (ev.kind === 'message') return `${head} has a new message from ${ev.peerId}'s agent${body}. Continuing.`;
  return `${head} -> ${stateWord(ev.state)}${body}. Continuing.`;
}

export interface WaitPort {
  /** Sessions currently holding a persistent WaitForA2A. */
  listWaiting(): Array<{ sessionId: string; state: WaitA2AState }>;
  /** Clear the wait and resume the session with `note` as the user text. */
  resume(sessionId: string, note: string): void;
  /** A queued send got its real task id from the peer: repoint waits that named the placeholder. */
  renameTask?(fromId: string, toId: string): void;
}

/**
 * Does an INBOUND message concern this wait (design 6.3 step 5: a session
 * sleeping in WaitForA2A "on this peer, context or task" is woken by it)?
 * Looser than `inScope`: any one of peer, context, or the context of a task
 * being waited on is enough.
 */
export function messageConcerns(w: Pick<WaitA2AState, 'peer' | 'contextId'>, on: { peerId: string; contextId: string }, waitedTaskContexts: string[]): boolean {
  if (w.peer && w.peer === on.peerId) return true;
  if (w.contextId && w.contextId === on.contextId) return true;
  return !!on.contextId && waitedTaskContexts.includes(on.contextId);
}

/** Rewrite a stored wait after a queued placeholder task got its real id. */
export function renameInWait(w: WaitA2AState, fromId: string, toId: string): WaitA2AState | null {
  if (!w.taskIds.includes(fromId)) return null;
  return { ...w, taskIds: w.taskIds.map((x) => (x === fromId ? toId : x)) };
}

/**
 * Timer path decision (design 6.4), shared by agent.ts (via index.ts) and the
 * tests: poll stale tasks, then resume, time out, or sleep again. Never
 * calls the model; the caller resumes the session only on `note`.
 */
export async function decideTimerWake(
  poll: (state: WaitA2AState) => Promise<string | null>,
  state: WaitA2AState,
  now: number
): Promise<{ note: string } | { sleepUntil: number }> {
  let note: string | null = null;
  try {
    note = await poll(state);
  } catch {
    note = null;
  }
  if (note) return { note };
  if (now >= state.deadlineTs) {
    return { note: `[WaitForA2A] timed out: nothing matched before the deadline (${new Date(state.deadlineTs).toISOString()}). Check A2ATasks for the current state.` };
  }
  return { sleepUntil: Math.min(state.deadlineTs, now + (state.pollStaleMs || POLL_STALE_MS)) };
}

interface InProcessWaiter {
  state: WaitA2AState;
  resolve(note: string): void;
}

export class Waiters {
  private readonly inProcess = new Set<InProcessWaiter>();

  constructor(private readonly port: WaitPort | undefined) {}

  /**
   * A task we created changed (push, poll or our own cancel). Wakes every
   * matching waiter; returns the sessions resumed, for the audit and tests.
   */
  onTaskEvent(ev: A2ATaskEvent): string[] {
    const woke: string[] = [];
    const note = resumeNote(ev);
    for (const w of [...this.inProcess]) {
      if (eventWakes(w.state, ev)) {
        this.inProcess.delete(w);
        w.resolve(note);
      }
    }
    if (!this.port) return woke;
    let rows: Array<{ sessionId: string; state: WaitA2AState }> = [];
    try {
      rows = this.port.listWaiting();
    } catch {
      return woke;
    }
    for (const r of rows) {
      if (!eventWakes(r.state, ev)) continue;
      try {
        this.port.resume(r.sessionId, note);
        woke.push(r.sessionId);
      } catch {
        /* the session may have been archived meanwhile */
      }
    }
    return woke;
  }

  /**
   * Block in-process until a matching event, the deadline, or abort
   * (subagents only). `poll` is the GET /tasks backstop: it returns a resume
   * note when a polled task already matches, else null.
   */
  waitInProcess(state: WaitA2AState, poll: () => Promise<string | null>, opts: { signal?: AbortSignal; now?: () => number; pollMs?: number } = {}): Promise<string> {
    const now = opts.now ?? Date.now;
    const pollMs = opts.pollMs ?? SUBAGENT_POLL_MS;
    return new Promise<string>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const finish = (note: string) => {
        if (timer) clearTimeout(timer);
        this.inProcess.delete(entry);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(note);
      };
      const entry: InProcessWaiter = { state, resolve: finish };
      const onAbort = () => finish('[WaitForA2A] aborted.');
      if (opts.signal?.aborted) return finish('[WaitForA2A] aborted.');
      opts.signal?.addEventListener('abort', onAbort);
      this.inProcess.add(entry);
      const tick = async () => {
        if (!this.inProcess.has(entry)) return;
        let note: string | null = null;
        try {
          note = await poll();
        } catch {
          note = null;
        }
        if (!this.inProcess.has(entry)) return;
        if (note) return finish(note);
        const left = state.deadlineTs - now();
        if (left <= 0) return finish(`[WaitForA2A] timed out: nothing matched before the deadline.`);
        timer = setTimeout(tick, Math.min(pollMs, left));
        timer.unref?.();
      };
      const left = Math.max(0, state.deadlineTs - now());
      timer = setTimeout(tick, Math.min(pollMs, left));
      timer.unref?.();
    });
  }

  inProcessCount(): number {
    return this.inProcess.size;
  }
}
