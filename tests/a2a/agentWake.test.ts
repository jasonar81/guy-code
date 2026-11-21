/**
 * The REAL agent.ts WaitForA2A branches (design 6.4), with db.ts mocked the
 * same way sleepingTool.test.ts does:
 *   - restart mid-wait: wakeSleepingToolSweep -> wakeSleepingTool reaches the
 *     wait_a2a branch, asks a2a/index for a decision, and either re-sleeps
 *     (no model call: streamMessage untouched) or resumes with the note;
 *   - a new user turn (runUserTurn) clears wait_a2a;
 *   - Stop (cancelRun) on a sleeping session clears wait_a2a.
 * streamMessage is a spy, so "zero model calls while waiting" is asserted on
 * the real loop too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  id: string;
  project_id: string;
  cwd: string | null;
  jsonl_path: string;
  api_key_id: string | null;
  archived: number;
  wake_at_ts: number | null;
  state: string;
  wait_a2a: string | null;
};

const rows: Row[] = [];
const waitA2AWrites: Array<{ id: string; state: unknown }> = [];
const stateWrites: Array<{ id: string; state: string }> = [];

vi.mock('../../electron/db', () => ({
  listSleepingToolSessions: () => rows.filter((r) => r.state === 'sleeping-tool'),
  listSessionsAll: () => [...rows],
  getSessionById: (id: string) => rows.find((r) => r.id === id),
  setSessionState: (id: string, state: string) => {
    stateWrites.push({ id, state });
    const r = rows.find((x) => x.id === id);
    if (r) r.state = state;
  },
  setSessionWakeAt: (id: string, ts: number | null) => {
    const r = rows.find((x) => x.id === id);
    if (r) r.wake_at_ts = ts;
  },
  setSessionWaitA2A: (id: string, state: unknown) => {
    waitA2AWrites.push({ id, state });
    const r = rows.find((x) => x.id === id);
    if (r) r.wait_a2a = state ? JSON.stringify(state) : null;
  },
  getSessionWaitA2A: (id: string) => {
    const r = rows.find((x) => x.id === id);
    return r?.wait_a2a ? JSON.parse(r.wait_a2a) : null;
  },
  setSessionWaitCondition: () => {},
  getSessionWaitCondition: () => null,
  insertAuditEvent: () => {},
  insertUsageEvent: () => {},
  setSessionPending: () => {},
  getSessionPending: () => undefined,
  getSessionApiKey: () => null,
  isSessionArchived: (id: string) => rows.find((r) => r.id === id)?.archived === 1,
  upsertSession: () => {},
  getSetting: () => null,
  setSetting: () => {},
  listWaitingOnSystemSessions: () => [],
}));

vi.mock('../../electron/agentEvents', () => ({
  broadcastAgentEvent: vi.fn(),
  broadcastStateChanged: vi.fn(),
}));

const streamMessage = vi.fn(async () => {
  throw new Error('no model in this test');
});
vi.mock('../../electron/anthropic', () => ({
  buildSystemBlocks: () => [],
  streamMessage: (...a: unknown[]) => streamMessage(...(a as [])),
  withConversationCacheBreakpoint: (m: unknown) => m,
  DEFAULT_MODEL: 'claude-test',
}));
vi.mock('../../electron/secret', () => ({ getDefaultApiKeyId: () => null }));
vi.mock('../../electron/budget', () => ({ precheckCall: () => ({ allowed: true, capMicros: 0, spentMicros: 0 }) }));

const decisions: Array<{ note: string } | { sleepUntil: number }> = [];
const timerWake = vi.fn(async () => decisions.shift() ?? { sleepUntil: Date.now() + 600_000 });
vi.mock('../../electron/a2a/index', () => ({ a2aTimerWake: (s: unknown) => timerWake(s as never) }));

import { cancelRun, runUserTurn, wakeSleepingToolSweep } from '../../electron/agent';

const wait = (deadlineTs: number) => ({ taskIds: ['t-1'], peer: null, contextId: null, states: null, deadlineTs, pollStaleMs: 600_000, startedTs: 0 });

function sleeper(id: string, wakeAt: number, w: unknown): Row {
  const r: Row = { id, project_id: 'p', cwd: '', jsonl_path: `/tmp/${id}.jsonl`, api_key_id: null, archived: 0, wake_at_ts: wakeAt, state: 'sleeping-tool', wait_a2a: JSON.stringify(w) };
  rows.push(r);
  return r;
}

beforeEach(() => {
  rows.length = 0;
  waitA2AWrites.length = 0;
  stateWrites.length = 0;
  decisions.length = 0;
  streamMessage.mockClear();
  timerWake.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('agent.ts WaitForA2A wake path (restart survival)', () => {
  it('the post-restart sweep runs the A2A timer path: nothing yet -> re-sleep, no model call', async () => {
    const now = Date.now();
    const r = sleeper('s1', now - 1000, wait(now + 3_600_000));
    decisions.push({ sleepUntil: now + 600_000 });
    await wakeSleepingToolSweep();
    await vi.waitFor(() => expect(timerWake).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(r.wake_at_ts).toBe(now + 600_000));
    expect(r.state).toBe('sleeping-tool');
    expect(r.wait_a2a).not.toBeNull();
    expect(streamMessage).not.toHaveBeenCalled();
    expect(stateWrites.some((w) => w.id === 's1' && w.state === 'running')).toBe(false); // no turn at all
  });

  it('when the poll finds the answer it clears the wait and resumes with the note', async () => {
    const now = Date.now();
    const r = sleeper('s2', now - 1000, wait(now + 3_600_000));
    decisions.push({ note: '[WaitForA2A] dylan\'s task t-1 -> COMPLETED: "done". Continuing.' });
    await wakeSleepingToolSweep();
    await vi.waitFor(() => expect(r.wait_a2a).toBeNull());
    expect(r.wake_at_ts).toBeNull();
    // runUserTurn started: that is the resume (it then fails without Electron, which is fine here).
    await vi.waitFor(() => expect(stateWrites).toContainEqual({ id: 's2', state: 'running' }));
  });
});

describe('agent.ts cancels wait_a2a', () => {
  it('a new user turn cancels a pending WaitForA2A (mirrors wait_condition)', async () => {
    const r = sleeper('s3', Date.now() + 600_000, wait(Date.now() + 3_600_000));
    await runUserTurn({ sessionId: 's3', projectId: 'p', cwd: '', userText: 'new instructions', continueExisting: true, seedFromJsonl: r.jsonl_path }).catch(() => {});
    expect(waitA2AWrites).toContainEqual({ id: 's3', state: null });
    expect(r.wait_a2a).toBeNull();
    expect(timerWake).not.toHaveBeenCalled();
  });

  it('Stop on a sleeping session clears WaitForA2A and idles it', () => {
    const r = sleeper('s4', Date.now() + 600_000, wait(Date.now() + 3_600_000));
    cancelRun('s4');
    expect(r.wait_a2a).toBeNull();
    expect(r.state).toBe('idle');
  });
});
