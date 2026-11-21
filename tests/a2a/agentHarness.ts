/**
 * A scripted stand-in for agent.ts, so the A2A acceptance tests can run the
 * whole design 8.2 flow between two real A2A nodes without the real model.
 *
 * What it models, and why it is faithful enough:
 *   - A "model call" is one call to the script. The script sees the turn's
 *     history and returns tool calls; the harness runs them through the REAL
 *     A2A_TOOLS (A2ARequest, WaitForA2A, A2AReply...) and loops until the
 *     script returns nothing or a tool returns `sleepUntil`, exactly the exit
 *     rule agent.ts uses. `modelCalls` is what the "zero model calls while
 *     waiting" acceptance check counts.
 *   - Sessions are rows with the same states agent.ts writes (running, idle,
 *     sleeping-tool), so router.deliveryMode sees what it would in the app.
 *   - The wake paths mirror a2a/index.ts (push -> resume) and agent.ts
 *     (timer / governor sweep -> waiters.decideTimerWake).
 *
 * The real agent.ts branch is covered separately (agentWake.test.ts) with the
 * DB mocked; this file is about the protocol and the wait semantics.
 */
import type { A2ANode } from '../../electron/a2a/node';
import type { RoutableSession, SessionPort } from '../../electron/a2a/router';
import { decideTimerWake, messageConcerns, renameInWait, type WaitA2AState, type WaitPort } from '../../electron/a2a/waiters';
import { A2A_TOOLS, setA2ANodeResolver, setA2AWaitStore } from '../../electron/a2aTools';
import { session as mkSession } from './helpers';

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}
export interface TurnHistory {
  /** The text that started this turn (user text, envelope, or resume note). */
  input: string;
  /** Tool results so far in this turn, in order. */
  results: Array<{ tool: string; result: string }>;
}
export type Script = (sessionId: string, h: TurnHistory) => ToolCall[] | Promise<ToolCall[]>;

interface Sess {
  row: RoutableSession;
  wait: WaitA2AState | null;
  wakeAt: number | null;
}

/** Every harness, by session id, so the single global wait store can dispatch. */
const bySession = new Map<string, AgentHarness>();

setA2AWaitStore({
  setWait: (id, st) => void (bySession.get(id)!.sessions.get(id)!.wait = st),
  setWakeAt: (id, ts) => void (bySession.get(id)!.sessions.get(id)!.wakeAt = ts),
  setSleeping: (id) => void (bySession.get(id)!.sessions.get(id)!.row.state = 'sleeping-tool'),
});

export class AgentHarness {
  readonly sessions = new Map<string, Sess>();
  readonly modelCalls: Array<{ sessionId: string; input: string }> = [];
  readonly toolLog: Array<{ sessionId: string; tool: string; input: Record<string, unknown>; result: string }> = [];
  readonly notes: string[] = [];
  node!: A2ANode;
  private inflight = new Set<Promise<void>>();

  constructor(public script: Script) {}

  addSession(id: string, title: string): RoutableSession {
    const row = mkSession({ id, title, user_title: title });
    this.sessions.set(id, { row, wait: null, wakeAt: null });
    bySession.set(id, this);
    return row;
  }

  /** SessionPort for the node (router delivery). */
  readonly port: SessionPort = {
    listSessions: () => [...this.sessions.values()].map((s) => s.row),
    resolveSession: (rows, ref) => {
      const q = ref.toLowerCase();
      const hits = rows.filter((r) => (r.user_title || r.title || '').toLowerCase().includes(q));
      return hits.length === 1 ? { session: hits[0] } : { error: 'none' };
    },
    isRunning: (id) => this.sessions.get(id)?.row.state === 'running',
    queueInterrupt: (id, text) => void this.notes.push(`interrupt ${id}: ${text.slice(0, 60)}`),
    startTurn: (s, text) => this.startTurn(s.id, text),
    getOrCreateInboxSession: () => [...this.sessions.values()][0].row,
    notify: (t, b) => void this.notes.push(`${t}: ${b}`),
    isWaitingFor: (sid, on) => {
      const w = this.sessions.get(sid)?.wait;
      if (!w) return false;
      const ctxs = w.taskIds.map((id) => this.node.store.getTask(id)?.context_id).filter((x): x is string => !!x);
      return messageConcerns(w, on, ctxs);
    },
  };

  /** WaitPort for the node (push path), mirroring a2a/index.ts resumeWaiter. */
  readonly waits: WaitPort = {
    listWaiting: () => [...this.sessions.values()].filter((s) => s.wait).map((s) => ({ sessionId: s.row.id, state: s.wait! })),
    resume: (id, note) => {
      const s = this.sessions.get(id)!;
      s.wait = null;
      s.wakeAt = null;
      this.startTurn(id, note);
    },
    renameTask: (from, to) => {
      for (const s of this.sessions.values()) {
        if (s.wait) s.wait = renameInWait(s.wait, from, to) ?? s.wait;
      }
    },
  };

  /** A new user message (agent.ts runUserTurn): cancels any WaitForA2A first. */
  userTurn(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId)!;
    s.wait = null;
    s.wakeAt = null;
    this.startTurn(sessionId, text);
    return this.idle();
  }

  private startTurn(sessionId: string, text: string): void {
    const p = (async () => {
      await new Promise((r) => setImmediate(r)); // fire and forget, like runUserTurn from an HTTP handler
      await this.runTurn(sessionId, text);
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  private async runTurn(sessionId: string, input: string): Promise<void> {
    const s = this.sessions.get(sessionId)!;
    s.row.state = 'running';
    const h: TurnHistory = { input, results: [] };
    for (let round = 0; round < 20; round++) {
      this.modelCalls.push({ sessionId, input: round === 0 ? input : `(round ${round})` });
      const calls = await this.script(sessionId, h);
      if (!calls.length) break;
      let slept = false;
      for (const c of calls) {
        setA2ANodeResolver(async () => this.node); // synchronous read at the top of execute()
        const r = await A2A_TOOLS[c.tool].execute(c.input, { sessionId, cwd: '' });
        const text = typeof r === 'string' ? r : r.modelContent.map((b) => ('text' in b ? b.text : '')).join('');
        h.results.push({ tool: c.tool, result: text });
        this.toolLog.push({ sessionId, tool: c.tool, input: c.input, result: text });
        if (typeof r !== 'string' && r.sleepUntil) {
          slept = true;
          break;
        }
      }
      if (slept) return; // state is sleeping-tool; the turn ends with no further model call
    }
    s.row.state = 'idle';
  }

  /**
   * The governor sweep / wake timer for one session (agent.ts
   * wakeSleepingTool's WaitForA2A branch): poll, then resume or re-sleep.
   */
  async timerWake(sessionId: string, now: number): Promise<'resumed' | 'slept' | 'none'> {
    const s = this.sessions.get(sessionId)!;
    if (!s.wait || s.row.state !== 'sleeping-tool') return 'none';
    const d = await decideTimerWake((w) => this.node.pollForWait(w, w.pollStaleMs), s.wait, now);
    if (!s.wait) {
      // The poll's own update reached the waiter through the event path (as a
      // push would) and that resumed it; agent.ts then returns without a
      // second resume, which is what we do here too.
      await this.idle();
      return 'resumed';
    }
    if ('sleepUntil' in d) {
      s.wakeAt = d.sleepUntil;
      return 'slept';
    }
    s.wait = null;
    s.wakeAt = null;
    this.startTurn(sessionId, d.note);
    await this.idle();
    return 'resumed';
  }

  /** Wait for every in-flight turn (and the ones they start). */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && this.inflight.size; i++) await Promise.all([...this.inflight]);
  }

  callsFor(sessionId: string): number {
    return this.modelCalls.filter((m) => m.sessionId === sessionId).length;
  }
}
