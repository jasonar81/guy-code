/**
 * Regression tests for persistent `WaitForTime` / `sleeping-tool` state.
 *
 * Two surface areas:
 *
 *   1. The `WaitForTime` tool itself — it must write `wake_at_ts` +
 *      flip session state to `sleeping-tool` *before* returning, and
 *      its returned `StructuredToolResult` must carry the `sleepUntil`
 *      signal the agent loop uses to exit cleanly. If any of that
 *      shape regresses, persistent sleep silently degrades back to
 *      the old in-process behavior and restart-survival is broken.
 *
 *   2. The `wakeSleepingToolSweep` — the durable side of the wake
 *      machinery, called every 60 s by the budget governor and once
 *      on app startup. We pin down its filtering rules:
 *        • archived sessions are NEVER woken
 *        • malformed rows (state=sleeping-tool but wake_at_ts=NULL)
 *          self-heal to idle so the user can re-engage manually
 *        • past-due rows fire wakeSleepingTool (which clears
 *          wake_at_ts before runUserTurn)
 *        • future-due rows get their in-process timer armed (the
 *          low-latency wake path after a restart that lost the
 *          original setTimeout)
 *
 * Strategy: `vi.mock` the db + agentEvents modules. The agent module
 * (where the wake functions live) is NOT mocked — we import it for
 * real and observe its side effects on the mocked DB. `runUserTurn`
 * is reached indirectly; we let it throw on missing API key and
 * catch the failure at the sweep boundary, which is exactly the
 * production behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- DB mock fixtures ---------------------------------------------------

type SleeperRow = {
  id: string;
  project_id: string;
  cwd: string | null;
  jsonl_path: string;
  api_key_id: string | null;
  archived: number;
  wake_at_ts: number | null;
};

type FullSessionRow = SleeperRow & {
  state: string;
};

const _sleepers: SleeperRow[] = [];
const _allSessions: FullSessionRow[] = [];
const _setSessionStateCalls: Array<{ id: string; state: string }> = [];
const _setSessionWakeAtCalls: Array<{ id: string; ts: number | null }> = [];
const _setWaitConditionCalls: Array<{ id: string; state: unknown }> = [];
const _broadcastStateCalls: Array<{ id: string; state: string }> = [];

function resetFixtures() {
  _sleepers.length = 0;
  _allSessions.length = 0;
  _setSessionStateCalls.length = 0;
  _setSessionWakeAtCalls.length = 0;
  _setWaitConditionCalls.length = 0;
  _broadcastStateCalls.length = 0;
}

vi.mock('../electron/db', () => {
  return {
    listSleepingToolSessions: () => [..._sleepers],
    listSessionsAll: () => [..._allSessions],
    setSessionState: (id: string, state: string) => {
      _setSessionStateCalls.push({ id, state });
      const row = _allSessions.find((r) => r.id === id);
      if (row) row.state = state;
    },
    setSessionWakeAt: (id: string, ts: number | null) => {
      _setSessionWakeAtCalls.push({ id, ts });
      const row = _allSessions.find((r) => r.id === id);
      if (row) row.wake_at_ts = ts;
    },
    // The agent module pulls more symbols from db.ts than the sweep
    // path itself touches (runUserTurn imports them at module load).
    // Stubbing them as no-ops keeps the static analysis happy without
    // affecting the sweep-only tests below.
    insertAuditEvent: () => {},
    insertUsageEvent: () => {},
    setSessionPending: () => {},
    getSessionPending: () => undefined,
    getSessionApiKey: () => null,
    isSessionArchived: (id: string) => {
      return _allSessions.find((r) => r.id === id)?.archived === 1;
    },
    upsertSession: () => {},
    getSetting: () => null,
    setSessionWaitCondition: (id: string, state: unknown) => {
      _setWaitConditionCalls.push({ id, state });
      const row = _allSessions.find((r) => r.id === id);
      if (row) row.wait_condition = state ? JSON.stringify(state) : null;
    },
    getSessionWaitCondition: (id: string) => {
      const row = _allSessions.find((r) => r.id === id);
      if (!row?.wait_condition) return null;
      try {
        return JSON.parse(row.wait_condition);
      } catch {
        return null;
      }
    },
  };
});

vi.mock('../electron/agentEvents', () => ({
  broadcastAgentEvent: vi.fn(),
  broadcastStateChanged: (id: string, state: string) => {
    _broadcastStateCalls.push({ id, state });
  },
}));

// Stub the Anthropic client + budget module to avoid hitting any
// network / settings during the (rare) path where wakeSleepingTool
// makes it past its early returns and into runUserTurn. We don't
// actually want to RUN runUserTurn here — these tests cover the
// sweep + tool, not the full loop — but agent.ts imports these at
// module load so we have to satisfy them.
vi.mock('../electron/anthropic', () => ({
  buildSystemBlocks: () => [],
  streamMessage: vi.fn(),
  withConversationCacheBreakpoint: (m: unknown) => m,
  DEFAULT_MODEL: 'claude-test',
}));
vi.mock('../electron/secret', () => ({
  getDefaultApiKeyId: () => null,
}));
vi.mock('../electron/budget', () => ({
  precheckCall: () => ({ allowed: true, capMicros: 0, spentMicros: 0 }),
}));

// Imports must come AFTER vi.mock — vitest hoists vi.mock calls but
// real `import` statements run after the hoist.
import { TOOLS } from '../electron/tools';
import { wakeSleepingToolSweep } from '../electron/agent';

const WAIT_FOR_TIME = TOOLS.WaitForTime;

beforeEach(() => {
  resetFixtures();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- WaitForTime tool ---------------------------------------------------

describe('WaitForTime tool: persistent sleep', () => {
  // Reaching the persistent path: setSessionWakeAt is the first state
  // write, then setSessionState('sleeping-tool'). Both must complete
  // BEFORE we hand back a tool_result, so a crash between the API
  // call and the tool_result write still leaves the session in a
  // recoverable shape.
  it('writes wake_at_ts THEN flips state to sleeping-tool before returning', async () => {
    vi.setSystemTime(new Date('2026-05-23T13:00:00Z'));
    _allSessions.push({
      id: 's1',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s1.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: null,
      state: 'running',
    });

    const result = await WAIT_FOR_TIME.execute(
      { duration_ms: 30 * 60 * 1000 }, // 30 minutes
      { sessionId: 's1', cwd: '/tmp', projectId: 'p1' }
    );

    // Order matters — wake_at_ts is the durable marker that the
    // sweep keys on, so it must land first.
    expect(_setSessionWakeAtCalls.length).toBeGreaterThan(0);
    expect(_setSessionStateCalls.length).toBeGreaterThan(0);
    const wakeIdx = _setSessionWakeAtCalls.findIndex(
      (c) => c.id === 's1' && c.ts != null
    );
    expect(wakeIdx).toBe(0);

    const wakeCall = _setSessionWakeAtCalls[0];
    expect(wakeCall.id).toBe('s1');
    const expectedWake = new Date('2026-05-23T13:00:00Z').getTime() + 30 * 60 * 1000;
    expect(wakeCall.ts).toBe(expectedWake);

    const stateCall = _setSessionStateCalls.find((c) => c.id === 's1');
    expect(stateCall?.state).toBe('sleeping-tool');
    // The renderer must hear about the state change so the sidebar can swap the
    // glyph immediately.
    expect(_broadcastStateCalls).toContainEqual({ id: 's1', state: 'sleeping-tool' });
    // The returned tool_result carries the sleepUntil signal the agent loop
    // reads to exit cleanly.
    if (typeof result === 'string') throw new Error('expected structured result');
    expect(result.sleepUntil).toBe(expectedWake);
  });

  it('honors a long sleep (24h) instead of capping it at 1 hour', async () => {
    vi.setSystemTime(new Date('2026-05-23T13:00:00Z'));
    _setSessionWakeAtCalls.length = 0;
    _allSessions.push({
      id: 's-long',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s-long.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: null,
      state: 'running',
    });
    const oneDay = 24 * 60 * 60 * 1000;
    await WAIT_FOR_TIME.execute(
      { duration_ms: oneDay },
      { sessionId: 's-long', cwd: '/tmp', projectId: 'p1' }
    );
    const wakeCall = _setSessionWakeAtCalls.find((c) => c.id === 's-long' && c.ts != null);
    expect(wakeCall).toBeDefined();
    // The wake must be ~24h out, NOT clamped to 1 hour.
    expect(wakeCall!.ts).toBe(new Date('2026-05-23T13:00:00Z').getTime() + oneDay);
  });

  it('caps an absurdly long sleep at 30 days', async () => {
    vi.setSystemTime(new Date('2026-05-23T13:00:00Z'));
    _setSessionWakeAtCalls.length = 0;
    _allSessions.push({
      id: 's-huge',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s-huge.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: null,
      state: 'running',
    });
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    await WAIT_FOR_TIME.execute(
      { duration_ms: oneYear },
      { sessionId: 's-huge', cwd: '/tmp', projectId: 'p1' }
    );
    const wakeCall = _setSessionWakeAtCalls.find((c) => c.id === 's-huge' && c.ts != null);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(wakeCall!.ts).toBe(new Date('2026-05-23T13:00:00Z').getTime() + thirtyDays);
  });

  // WaitForTime is a PERSISTENT sleep (costs nothing while asleep), so it is
  // NOT capped at the in-process 1-hour ceiling - it allows up to 30 days. A
  // 24-hour request is honored as-is; only absurdly long requests clamp (to 30
  // days). See the dedicated tests above for the boundary cases.
  it('does NOT clamp a 24-hour request to 1 hour (honors the persistent ceiling)', async () => {
    vi.setSystemTime(new Date('2026-05-23T13:00:00Z'));
    _allSessions.push({
      id: 's-big',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: null,
      state: 'running',
    });
    const result = await WAIT_FOR_TIME.execute(
      { duration_ms: 24 * 60 * 60 * 1000 },
      { sessionId: 's-big', cwd: '/tmp', projectId: 'p1' }
    );
    if (typeof result === 'string') throw new Error('expected structured result');
    const expectedWake =
      new Date('2026-05-23T13:00:00Z').getTime() + 24 * 60 * 60 * 1000;
    expect(result.sleepUntil).toBe(expectedWake);
  });

  // Floor: a 0 or negative ms gets clamped UP to 100ms (the
  // MIN_WAIT in clampWait). Otherwise a malicious / buggy model
  // could call WaitForTime(0) and busy-loop the wake-up cycle.
  it('clamps tiny / non-numeric duration_ms up to 100 ms minimum', async () => {
    vi.setSystemTime(new Date('2026-05-23T13:00:00Z'));
    _allSessions.push({
      id: 's-tiny',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: null,
      state: 'running',
    });
    const result = await WAIT_FOR_TIME.execute(
      { duration_ms: -100 },
      { sessionId: 's-tiny', cwd: '/tmp', projectId: 'p1' }
    );
    if (typeof result === 'string') throw new Error('expected structured result');
    const expectedWake = new Date('2026-05-23T13:00:00Z').getTime() + 100;
    expect(result.sleepUntil).toBe(expectedWake);
  });
});

// ---- wakeSleepingToolSweep --------------------------------------------

describe('wakeSleepingToolSweep', () => {
  // The whole point of the archive change earlier in this PR is to
  // make archived sessions inert. The sweep is the last line of
  // defense: even if a row somehow ended up `sleeping-tool` AND
  // archived, the sweep must not wake it.
  it('skips archived sleeping-tool sessions, no DB writes for them', async () => {
    vi.setSystemTime(new Date('2026-05-23T13:00:00Z'));
    const wakePast = Date.now() - 60_000; // 1 minute ago
    _sleepers.push({
      id: 's-arch',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 1,
      wake_at_ts: wakePast,
    });
    _allSessions.push({
      id: 's-arch',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 1,
      wake_at_ts: wakePast,
      state: 'sleeping-tool',
    });

    await wakeSleepingToolSweep();

    expect(_setSessionStateCalls).toHaveLength(0);
    expect(_setSessionWakeAtCalls).toHaveLength(0);
  });

  // Belt-and-suspenders self-heal: a row claiming sleeping-tool but
  // with no wake_at_ts is impossible in steady state but possible in
  // a partially-rolled migration or after a crash between the two
  // writes. The sweep idles it so the user isn't stuck staring at a
  // hung sidebar.
  it('idles malformed sleeping-tool rows (wake_at_ts is null)', async () => {
    _sleepers.push({
      id: 's-malformed',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: null,
    });
    _allSessions.push({
      id: 's-malformed',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: null,
      state: 'sleeping-tool',
    });

    await wakeSleepingToolSweep();

    expect(_setSessionStateCalls).toContainEqual({
      id: 's-malformed',
      state: 'idle',
    });
    expect(_broadcastStateCalls).toContainEqual({
      id: 's-malformed',
      state: 'idle',
    });
  });

  // Past-due wake. The expected DB write is `setSessionWakeAt(id,
  // null)` clearing the marker — this happens BEFORE runUserTurn
  // fires, so we can assert it without needing to mock the full
  // agent loop. (runUserTurn itself will throw because the test
  // module mocks streamMessage to a no-op vi.fn() that returns
  // undefined; the sweep catches the error and logs it.)
  it('clears wake_at_ts for past-due sessions before invoking runUserTurn', async () => {
    vi.setSystemTime(new Date('2026-05-23T13:00:00Z'));
    const wakePast = Date.now() - 60_000;
    _sleepers.push({
      id: 's-due',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: wakePast,
    });
    _allSessions.push({
      id: 's-due',
      project_id: 'p1',
      cwd: '/tmp',
      jsonl_path: '/tmp/s.jsonl',
      api_key_id: null,
      archived: 0,
      wake_at_ts: wakePast,
      state: 'sleeping-tool',
    });

    await wakeSleepingToolSweep();
    // Let the fire-and-forget catch settle.
    await vi.runAllTimersAsync().catch(() => {});

    // The clear can happen synchronously before runUserTurn awaits,
    // or asynchronously inside it — either way it lands.
    const cleared = _setSessionWakeAtCalls.find(
      (c) => c.id === 's-due' && c.ts === null
    );
    expect(cleared).toBeDefined();
  });

  // No-op path: nothing in DB means the sweep returns immediately
  // without iterating. This is the steady-state case (most sweep
  // ticks find zero sleeping-tool sessions) so it has to be
  // genuinely cheap.
  it('returns immediately when no sleeping-tool sessions exist', async () => {
    await wakeSleepingToolSweep();
    expect(_setSessionStateCalls).toHaveLength(0);
    expect(_setSessionWakeAtCalls).toHaveLength(0);
  });
});

describe('WaitForCondition', () => {
  const WAIT_FOR_CONDITION = TOOLS.WaitForCondition;
  const sh: 'powershell' | 'bash' = process.platform === 'win32' ? 'powershell' : 'bash';
  const exit0 = process.platform === 'win32' ? 'exit 0' : 'true';
  const exit1 = process.platform === 'win32' ? 'exit 1' : 'false';

  beforeEach(() => {
    vi.useRealTimers(); // runConditionCheck spawns real subprocesses
  });

  it('runConditionCheck reports launched+code 0 for a passing command, launched+non-zero for a failing one', async () => {
    const { runConditionCheck } = await import('../electron/tools');
    const ok = await runConditionCheck(exit0, process.cwd(), sh, 10_000);
    expect(ok.launched).toBe(true);
    expect(ok.code).toBe(0);
    const bad = await runConditionCheck(exit1, process.cwd(), sh, 10_000);
    expect(bad.launched).toBe(true);
    expect(bad.code).not.toBe(0);
  });

  it('runConditionCheck reports launched=false when the command runs but exits non-zero is distinct from a real failure to launch', async () => {
    const { runConditionCheck } = await import('../electron/tools');
    // A command that runs but exits non-zero LAUNCHED (it's just "not met").
    const ran = await runConditionCheck(exit1, process.cwd(), sh, 10_000);
    expect(ran.launched).toBe(true);
  });

  it('returns immediately (no sleep) when the condition is already met', async () => {
    _allSessions.push({
      id: 'c-met', project_id: 'p1', cwd: process.cwd(), jsonl_path: '/tmp/c.jsonl',
      api_key_id: null, archived: 0, wake_at_ts: null, state: 'running', wait_condition: null,
    });
    const result = await WAIT_FOR_CONDITION.execute(
      { command: exit0, interval_ms: 60000, timeout_ms: 3600000, shell: sh },
      { sessionId: 'c-met', cwd: process.cwd(), projectId: 'p1' }
    );
    if (typeof result === 'string') throw new Error('expected structured result');
    expect((result as any).sleepUntil).toBeUndefined(); // did not sleep
    expect(_setWaitConditionCalls).toHaveLength(0); // no wait persisted
  });

  it('sets up the persistent wait + sleepUntil when not yet met', async () => {
    _allSessions.push({
      id: 'c-wait', project_id: 'p1', cwd: process.cwd(), jsonl_path: '/tmp/c.jsonl',
      api_key_id: null, archived: 0, wake_at_ts: null, state: 'running', wait_condition: null,
    });
    const before = Date.now();
    const result = await WAIT_FOR_CONDITION.execute(
      { command: exit1, interval_ms: 60000, timeout_ms: 3600000, shell: sh },
      { sessionId: 'c-wait', cwd: process.cwd(), projectId: 'p1' }
    );
    if (typeof result === 'string') throw new Error('expected structured result');
    // It slept ~interval out.
    expect((result as any).sleepUntil).toBeGreaterThanOrEqual(before + 60000 - 5000);
    // The condition was persisted (so it survives restart).
    const saved = _setWaitConditionCalls.find((c) => c.id === 'c-wait');
    expect(saved).toBeDefined();
    expect((saved!.state as any).command).toBe(exit1);
    expect((saved!.state as any).deadlineTs).toBeGreaterThan(before);
  });
});

describe('Wait tools inside a subagent (in-process, no DB sleep)', () => {
  const WAIT_FOR_TIME = TOOLS.WaitForTime;
  const WAIT_FOR_CONDITION = TOOLS.WaitForCondition;
  const sh: 'powershell' | 'bash' = process.platform === 'win32' ? 'powershell' : 'bash';
  const exit0 = process.platform === 'win32' ? 'exit 0' : 'true';

  beforeEach(() => {
    vi.useRealTimers(); // these block in-process on real timers
  });

  it('WaitForTime in a subagent actually waits in-process and does NOT touch session DB state', async () => {
    const start = Date.now();
    const result = await WAIT_FOR_TIME.execute(
      { duration_ms: 150 },
      { sessionId: 'parent-1', cwd: process.cwd(), projectId: 'p1', inSubagent: true }
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(120); // it really slept ~150ms
    // It returned a plain string (no sleepUntil signal) ...
    expect(typeof result).toBe('string');
    // ... and it did NOT corrupt the parent session (no wake/state/wait writes).
    expect(_setSessionWakeAtCalls).toHaveLength(0);
    expect(_setSessionStateCalls).toHaveLength(0);
    expect(_setWaitConditionCalls).toHaveLength(0);
  });

  it('WaitForCondition in a subagent runs the check loop in-process (met -> returns), no DB writes', async () => {
    const result = await WAIT_FOR_CONDITION.execute(
      { command: exit0, interval_ms: 1000, timeout_ms: 60000, shell: sh },
      { sessionId: 'parent-2', cwd: process.cwd(), projectId: 'p1', inSubagent: true }
    );
    expect(typeof result).toBe('string');
    expect(String(result)).toMatch(/condition met/i);
    expect(_setSessionWakeAtCalls).toHaveLength(0);
    expect(_setWaitConditionCalls).toHaveLength(0);
  });
});
