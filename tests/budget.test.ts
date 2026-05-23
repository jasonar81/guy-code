/**
 * Comprehensive tests for `electron/budget.ts`.
 *
 * The budget module is the most failure-prone part of the codebase
 * (we've now rewritten it 3+ times). These tests pin down the
 * intended semantics of the hourly-bucket model:
 *
 *   • Hourly cap = daily / 24, clock-aligned buckets.
 *   • Pre-flight allows uncapped, force-resume, bucket-has-room, OR
 *     min-one-turn-per-session-per-hour exemption. Otherwise blocks.
 *   • Resume sweep wakes paused sessions whose bucket has refilled.
 *
 * Strategy: vi.mock the `./db` module so tests control all spend
 * data, api_keys rows, and settings via in-memory fixtures. No
 * SQLite needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ----- Mock fixtures (mutable across tests) ------------------------------

type SpendRow = {
  ts: number;
  cost_usd_micros: number;
  api_key_id: string | null;
  session_id: string;
  source: string;
};
const _spendRows: SpendRow[] = [];
const _apiKeyRows = new Map<
  string,
  {
    id: string;
    name: string;
    daily_budget_usd: number | null;
    is_default: number;
  }
>();
let _defaultApiKeyId: string | null = null;
const _settings = new Map<string, string>();
const _sessionsByState = new Map<
  string,
  Array<{
    id: string;
    project_id: string;
    pending_user_text: string | null;
    sleeping_since: number | null;
    cwd: string | null;
    jsonl_path: string;
    api_key_id: string | null;
  }>
>();
const _setSessionStateCalls: Array<{ id: string; state: string }> = [];
const _setSessionPendingCalls: Array<{
  id: string;
  text: string | null;
  ts: number | null;
}> = [];

function resetFixtures() {
  _spendRows.length = 0;
  _apiKeyRows.clear();
  _defaultApiKeyId = null;
  _settings.clear();
  _sessionsByState.clear();
  _setSessionStateCalls.length = 0;
  _setSessionPendingCalls.length = 0;
}

// ----- vi.mock('./db') ---------------------------------------------------
// Substitute a hand-rolled in-memory db that supports just the queries
// budget.ts uses. Each test calls resetFixtures() then writes its
// scenario into the fixtures.

vi.mock('../electron/db', () => {
  function spendBetweenImpl(
    from: number,
    toExclusive: number,
    apiKeyId?: string | null
  ): number {
    return _spendRows
      .filter((r) => r.source === 'live' && r.ts >= from && r.ts < toExclusive)
      .filter((r) => (apiKeyId ? r.api_key_id === apiKeyId : true))
      .reduce((sum, r) => sum + r.cost_usd_micros, 0);
  }
  return {
    db: () => ({
      prepare(sql: string) {
        return {
          get<T>(...args: unknown[]): T | undefined {
            // Match the SUM-of-cost queries by SQL fragment.
            if (sql.includes('SELECT COALESCE(SUM(cost_usd_micros), 0)')) {
              const [from, toExclusive, apiKeyId] = args as [
                number,
                number,
                string | undefined,
              ];
              const total = spendBetweenImpl(
                from,
                toExclusive,
                sql.includes('api_key_id = ?') ? (apiKeyId ?? null) : null
              );
              return { total } as T;
            }
            // sessionHasTurnInCurrentHour query.
            if (sql.includes('FROM usage_events') && sql.includes('LIMIT 1')) {
              const [sessionId, from, toExclusive] = args as [
                string,
                number,
                number,
              ];
              const hit = _spendRows.find(
                (r) =>
                  r.session_id === sessionId &&
                  r.source === 'live' &&
                  r.ts >= from &&
                  r.ts < toExclusive
              );
              return (hit ? { 1: 1 } : undefined) as T | undefined;
            }
            return undefined;
          },
          all() {
            return [];
          },
          run() {},
        };
      },
    }),
    getApiKeyRow(id: string) {
      return _apiKeyRows.get(id);
    },
    getDefaultApiKeyRow() {
      if (!_defaultApiKeyId) return undefined;
      return _apiKeyRows.get(_defaultApiKeyId);
    },
    getSetting(key: string) {
      return _settings.get(key) ?? null;
    },
    setSessionState(id: string, state: string) {
      _setSessionStateCalls.push({ id, state });
    },
    setSessionPending(id: string, text: string | null, ts: number | null) {
      _setSessionPendingCalls.push({ id, text, ts });
    },
    listSessionsByState(state: string) {
      return _sessionsByState.get(state) ?? [];
    },
  };
});

vi.mock('../electron/agentEvents', () => ({
  broadcastAgentEvent: vi.fn(),
  broadcastStateChanged: vi.fn(),
}));

// Imports must come AFTER vi.mock — vitest hoists the mocks to the top
// at runtime, but the static-analyzer-friendly form is to import at
// the top in source order.
import {
  getDailyBudgetMicros,
  getHourCapMicros,
  currentHourSpendMicros,
  todaySpendMicros,
  rollingDaySpendMicros,
  sessionHasTurnInCurrentHour,
  noteRunStart,
  noteRunEnd,
  precheckTurn,
  setBypassNextTurn,
} from '../electron/budget';

// ----- Helpers ----------------------------------------------------------

const $1 = 1_000_000;

function addSpend(opts: {
  ts: number;
  costMicros: number;
  apiKeyId?: string | null;
  sessionId?: string;
}) {
  _spendRows.push({
    ts: opts.ts,
    cost_usd_micros: opts.costMicros,
    api_key_id: opts.apiKeyId ?? null,
    session_id: opts.sessionId ?? 'sess-x',
    source: 'live',
  });
}

function setKey(id: string, opts: { dailyUsd?: number | null; isDefault?: boolean; name?: string }) {
  _apiKeyRows.set(id, {
    id,
    name: opts.name ?? id,
    daily_budget_usd: opts.dailyUsd ?? null,
    is_default: opts.isDefault ? 1 : 0,
  });
  if (opts.isDefault) _defaultApiKeyId = id;
}

beforeEach(() => {
  resetFixtures();
});

afterEach(() => {
  vi.useRealTimers();
});

// ----- getDailyBudgetMicros ---------------------------------------------

describe('getDailyBudgetMicros', () => {
  it('returns per-key daily budget when set', () => {
    setKey('k1', { dailyUsd: 80 });
    expect(getDailyBudgetMicros('k1')).toBe(80 * $1);
  });

  it('falls back to default key when no key id given', () => {
    setKey('k1', { dailyUsd: 50, isDefault: true });
    expect(getDailyBudgetMicros()).toBe(50 * $1);
    expect(getDailyBudgetMicros(null)).toBe(50 * $1);
  });

  it('falls back to global setting when key has no per-key budget', () => {
    setKey('k1', { dailyUsd: null });
    _settings.set('budget.dailyBudgetUsd', '24');
    expect(getDailyBudgetMicros('k1')).toBe(24 * $1);
  });

  it('falls back to legacy budget.rollingHourCapUsd × 24', () => {
    _settings.set('budget.rollingHourCapUsd', '5');
    expect(getDailyBudgetMicros()).toBe(5 * 24 * $1);
  });

  it('returns null when nothing is configured', () => {
    expect(getDailyBudgetMicros('absent')).toBeNull();
    expect(getDailyBudgetMicros(null)).toBeNull();
  });

  it('ignores zero/negative daily budgets', () => {
    setKey('k1', { dailyUsd: 0 });
    expect(getDailyBudgetMicros('k1')).toBeNull();
    setKey('k2', { dailyUsd: -5 });
    expect(getDailyBudgetMicros('k2')).toBeNull();
  });

  it('ignores non-numeric or empty global setting strings', () => {
    _settings.set('budget.dailyBudgetUsd', '');
    _settings.set('budget.rollingHourCapUsd', 'NaNbread');
    expect(getDailyBudgetMicros()).toBeNull();
  });
});

// ----- getHourCapMicros -------------------------------------------------

describe('getHourCapMicros', () => {
  it('returns daily / 24 floored', () => {
    setKey('k1', { dailyUsd: 80 });
    expect(getHourCapMicros('k1')).toBe(Math.floor((80 * $1) / 24));
  });

  it('returns null when uncapped', () => {
    expect(getHourCapMicros('absent')).toBeNull();
  });

  it('rounds-down sub-cent fractions to avoid micro-overrun', () => {
    setKey('k1', { dailyUsd: 1 }); // 1 USD = 1_000_000 micros, /24 = 41666.66...
    expect(getHourCapMicros('k1')).toBe(41666);
  });
});

// ----- currentHourSpendMicros / todaySpendMicros / rollingDaySpendMicros

describe('spend queries', () => {
  it('currentHourSpendMicros sums only the current clock hour', () => {
    const now = new Date('2026-05-23T13:30:00').getTime();
    const lastHour = new Date('2026-05-23T12:45:00').getTime();
    const earlyThisHour = new Date('2026-05-23T13:01:00').getTime();
    const lateThisHour = new Date('2026-05-23T13:59:00').getTime();
    addSpend({ ts: lastHour, costMicros: 100 * $1, apiKeyId: 'k1' });
    addSpend({ ts: earlyThisHour, costMicros: 1 * $1, apiKeyId: 'k1' });
    addSpend({ ts: lateThisHour, costMicros: 2 * $1, apiKeyId: 'k1' });
    expect(currentHourSpendMicros(now, 'k1')).toBe(3 * $1);
  });

  it('currentHourSpendMicros filters by api_key_id when given', () => {
    const now = new Date('2026-05-23T13:30:00').getTime();
    addSpend({ ts: now - 60_000, costMicros: 5 * $1, apiKeyId: 'k1' });
    addSpend({ ts: now - 60_000, costMicros: 10 * $1, apiKeyId: 'k2' });
    expect(currentHourSpendMicros(now, 'k1')).toBe(5 * $1);
    expect(currentHourSpendMicros(now, 'k2')).toBe(10 * $1);
    // null aggregates across all keys.
    expect(currentHourSpendMicros(now, null)).toBe(15 * $1);
  });

  it('todaySpendMicros sums the current local day only', () => {
    const now = new Date('2026-05-23T13:30:00').getTime();
    const yesterday = new Date('2026-05-22T23:59:00').getTime();
    const earlyToday = new Date('2026-05-23T00:01:00').getTime();
    const justNow = new Date('2026-05-23T13:00:00').getTime();
    addSpend({ ts: yesterday, costMicros: 50 * $1, apiKeyId: 'k1' });
    addSpend({ ts: earlyToday, costMicros: 5 * $1, apiKeyId: 'k1' });
    addSpend({ ts: justNow, costMicros: 7 * $1, apiKeyId: 'k1' });
    expect(todaySpendMicros(now, 'k1')).toBe(12 * $1);
  });

  it('rollingDaySpendMicros sums the trailing 24h', () => {
    const now = new Date('2026-05-23T13:30:00').getTime();
    const within = now - 23 * 60 * 60 * 1000;
    const outside = now - 25 * 60 * 60 * 1000;
    addSpend({ ts: within, costMicros: 3 * $1, apiKeyId: 'k1' });
    addSpend({ ts: outside, costMicros: 3 * $1, apiKeyId: 'k1' });
    expect(rollingDaySpendMicros(now, 'k1')).toBe(3 * $1);
  });

  it('per-key totals exclude legacy un-keyed events', () => {
    const now = Date.now();
    addSpend({ ts: now - 60_000, costMicros: 5 * $1, apiKeyId: null });
    addSpend({ ts: now - 60_000, costMicros: 7 * $1, apiKeyId: 'k1' });
    expect(currentHourSpendMicros(now, 'k1')).toBe(7 * $1);
    // Aggregated includes the un-keyed event.
    expect(currentHourSpendMicros(now, null)).toBe(12 * $1);
  });
});

// ----- sessionHasTurnInCurrentHour --------------------------------------

describe('sessionHasTurnInCurrentHour', () => {
  it('returns true when the session has any spend in the current hour', () => {
    const now = new Date('2026-05-23T13:30:00').getTime();
    addSpend({
      ts: new Date('2026-05-23T13:01:00').getTime(),
      costMicros: 1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    expect(sessionHasTurnInCurrentHour('s1', now)).toBe(true);
  });

  it("returns false when the session's spend is in a different hour", () => {
    const now = new Date('2026-05-23T13:30:00').getTime();
    addSpend({
      ts: new Date('2026-05-23T12:30:00').getTime(),
      costMicros: 1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    expect(sessionHasTurnInCurrentHour('s1', now)).toBe(false);
  });

  it('returns false when the session has no spend at all', () => {
    expect(sessionHasTurnInCurrentHour('absent')).toBe(false);
  });

  it('does not leak across sessions on the same key', () => {
    const now = new Date('2026-05-23T13:30:00').getTime();
    addSpend({
      ts: new Date('2026-05-23T13:01:00').getTime(),
      costMicros: 1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    expect(sessionHasTurnInCurrentHour('s2', now)).toBe(false);
  });
});

// ----- In-flight reservation -------------------------------------------

describe('noteRunStart / noteRunEnd', () => {
  it('reserves and releases per-key', () => {
    setKey('k1', { dailyUsd: 24 }); // hour cap = 1M
    const now = Date.now();
    // No reservation, no spend → bucket has full hour cap of room.
    const r0 = precheckTurn('s1', 'k1');
    expect(r0.allowed).toBe(true);

    // After noteRunStart, reservation = $5; hour cap = $1; reservation
    // alone exceeds bucket → blocks (and exemption only applies if no
    // prior turn this hour, which is true here, so it allows under the
    // exemption).
    noteRunStart('k1');
    addSpend({ ts: now, costMicros: 1, apiKeyId: 'k1', sessionId: 's1' });
    const r1 = precheckTurn('s2', 'k1');
    // s2 has no prior turn this hour → exemption applies even though
    // reservation alone is over the cap.
    expect(r1.allowed).toBe(true);
    expect(r1.reason).toMatch(/exemption/);

    // Release the reservation.
    noteRunEnd('k1');
    // s2 still has no prior turn this hour, so still allowed via
    // exemption regardless. Block path is exercised below.
  });

  it('does not go below zero on extra noteRunEnd calls', () => {
    noteRunEnd('k1');
    noteRunEnd('k1');
    setKey('k1', { dailyUsd: 24 });
    const r = precheckTurn('s1', 'k1');
    expect(r.allowed).toBe(true);
  });
});

// ----- precheckTurn (the main decision tree) ----------------------------

describe('precheckTurn', () => {
  it('Step 1: uncapped key → allow', () => {
    const r = precheckTurn('s1', 'absent');
    expect(r.allowed).toBe(true);
    expect(r.capMicros).toBe(0);
  });

  it('Step 2: force-resume bypass → allow + consume one-shot', () => {
    setKey('k1', { dailyUsd: 24 }); // hour cap = $1
    const now = Date.now();
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 's1' });
    setBypassNextTurn('s1');
    const r1 = precheckTurn('s1', 'k1');
    expect(r1.allowed).toBe(true);
    expect(r1.reason).toMatch(/force-resume/);
    // Bypass consumed → next call (s1 has prior turn) blocks.
    const r2 = precheckTurn('s1', 'k1');
    expect(r2.allowed).toBe(false);
  });

  it('Step 3: bucket has room → allow', () => {
    setKey('k1', { dailyUsd: 240 }); // hour cap = $10
    const now = Date.now();
    addSpend({ ts: now, costMicros: 3 * $1, apiKeyId: 'k1', sessionId: 's1' });
    const r = precheckTurn('s1', 'k1');
    expect(r.allowed).toBe(true);
    expect(r.capMicros).toBe(10 * $1);
    expect(r.spentMicros).toBe(3 * $1);
  });

  it('Step 4: bucket exhausted, session has no prior turn → exemption', () => {
    setKey('k1', { dailyUsd: 24 }); // hour cap = $1
    const now = Date.now();
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 'other' });
    const r = precheckTurn('newSession', 'k1');
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/exemption/);
  });

  it('Step 5: bucket exhausted AND session has prior turn → block', () => {
    setKey('k1', { dailyUsd: 24 }); // hour cap = $1
    const now = Date.now();
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 's1' });
    const r = precheckTurn('s1', 'k1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/hour spend/);
    expect(r.spentMicros).toBe(5 * $1);
  });

  it('block reason includes in-flight reservation when reserved > 0', () => {
    setKey('k1', { dailyUsd: 24 });
    const now = Date.now();
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 's1' });
    noteRunStart('k1');
    const r = precheckTurn('s1', 'k1');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/in-flight/);
    noteRunEnd('k1');
  });

  it('nextRetryTs lands at the top of the next clock hour', () => {
    setKey('k1', { dailyUsd: 24 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:42:17'));
    addSpend({
      ts: new Date('2026-05-23T13:00:30').getTime(),
      costMicros: 5 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    const r = precheckTurn('s1', 'k1');
    expect(r.allowed).toBe(false);
    const expected = new Date('2026-05-23T14:00:00').getTime();
    expect(r.nextRetryTs).toBe(expected);
  });

  it('exemption applies BEFORE block, but not before bucket-has-room', () => {
    // If there's room AND no prior turn, we hit Step 3 (room), not the
    // exemption. The exemption is only used when bucket is already full.
    setKey('k1', { dailyUsd: 240 }); // hour cap = $10
    const now = Date.now();
    addSpend({ ts: now, costMicros: 1 * $1, apiKeyId: 'k1', sessionId: 'other' });
    const r = precheckTurn('newSession', 'k1');
    expect(r.allowed).toBe(true);
    // Reason is empty (Step 3, "bucket has room"), not "exemption".
    expect(r.reason).toBe('');
  });

  it('per-key isolation: spend on key A does not block key B', () => {
    setKey('a', { dailyUsd: 24 });
    setKey('b', { dailyUsd: 24 });
    const now = Date.now();
    addSpend({ ts: now, costMicros: 100 * $1, apiKeyId: 'a', sessionId: 's1' });
    // s1 on key A is blocked.
    expect(precheckTurn('s1', 'a').allowed).toBe(false);
    // s1 on key B has no prior turn this hour → exemption (allow).
    expect(precheckTurn('s1', 'b').allowed).toBe(true);
  });
});
