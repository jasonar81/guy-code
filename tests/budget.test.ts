/**
 * Comprehensive tests for `electron/budget.ts` — hourly carry-over model.
 *
 * The budget governor is the most failure-prone part of the codebase
 * (rewritten several times). These tests pin down the carry-over model
 * the user explicitly specified:
 *
 *   • base_hourly = daily_budget / 24, constant.
 *   • Each hour's effective_cap = base_hourly + adjustment_so_far.
 *   • Underspend rolls forward, overspend rolls forward as a negative
 *     adjustment. Walked example (base=5, clean start):
 *       H1: adj=0,  effective=5, spent=7 → new_adj = 5−7 = −2
 *       H2: adj=−2, effective=3, spent=2 → new_adj = 3−2 = +1
 *       H3: adj=+1, effective=6, …
 *   • Pre-flight before EVERY API call (not per-turn). Allowed when
 *     uncapped, force-resume bypass, bucket has room, or session has
 *     no calls in the current hour (min-one-call-per-hour exemption).
 *   • Reset zeros the carry-over and re-anchors to the current hour.
 *   • Settle-on-read handles arbitrary offline gaps (app restart after
 *     hours / days).
 *
 * Strategy: vi.mock the `./db` module so tests fully control spend
 * data, api_keys rows, and settings via in-memory fixtures. No SQLite
 * needed. Adjustment columns are simulated directly on the fake row.
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
    adjustment_micros: number;
    adjustment_hour_ts: number;
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
    setApiKeyBudgetAdjustment(id: string, adjustmentMicros: number, hourTs: number) {
      const row = _apiKeyRows.get(id);
      if (row) {
        row.adjustment_micros = Math.round(adjustmentMicros);
        row.adjustment_hour_ts = Math.round(hourTs);
      }
    },
    resetApiKeyBudgetAdjustment(id: string, hourTs: number) {
      const row = _apiKeyRows.get(id);
      if (row) {
        row.adjustment_micros = 0;
        row.adjustment_hour_ts = Math.round(hourTs);
      }
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

// Imports must come AFTER vi.mock — vitest hoists them at runtime.
import {
  getDailyBudgetMicros,
  getBaseHourCapMicros,
  getEffectiveHourCapMicros,
  getHourCapMicros,
  currentHourSpendMicros,
  todaySpendMicros,
  rollingDaySpendMicros,
  sessionHasCallInCurrentHour,
  precheckCall,
  precheckTurn,
  setBypassNextTurn,
  getBypassUntil,
  _resetBypassForTests,
  FORCE_RESUME_GRACE_MS,
  resetBudgetAdjustment,
} from '../electron/budget';

// ----- Helpers ----------------------------------------------------------

const $1 = 1_000_000;
const HOUR_MS = 60 * 60 * 1000;

function hourTs(iso: string): number {
  // Helper to spell out "start of this hour" in tests.
  return new Date(iso).getTime();
}

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

function setKey(
  id: string,
  opts: {
    dailyUsd?: number | null;
    isDefault?: boolean;
    name?: string;
    /** Pre-seed adjustment (e.g. for migration / restart scenarios). */
    adjustmentUsd?: number;
    /** Pre-seed adjustment_hour_ts. Defaults to 0 (uninitialized). */
    adjustmentHourTs?: number;
  }
) {
  _apiKeyRows.set(id, {
    id,
    name: opts.name ?? id,
    daily_budget_usd: opts.dailyUsd ?? null,
    is_default: opts.isDefault ? 1 : 0,
    adjustment_micros: Math.round((opts.adjustmentUsd ?? 0) * $1),
    adjustment_hour_ts: opts.adjustmentHourTs ?? 0,
  });
  if (opts.isDefault) _defaultApiKeyId = id;
}

function getRow(id: string) {
  const r = _apiKeyRows.get(id);
  if (!r) throw new Error(`test bug: no row for key ${id}`);
  return r;
}

beforeEach(() => {
  resetFixtures();
  // The force-resume grace map is module-level singleton state; if a
  // previous test set a window and the next test ran with `now`
  // before its expiry, the grace would leak across tests.
  _resetBypassForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ----- getDailyBudgetMicros (unchanged from old model) ------------------

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
});

// ----- Base + effective hour cap ----------------------------------------

describe('getBaseHourCapMicros', () => {
  it('returns daily / 24 floored', () => {
    setKey('k1', { dailyUsd: 80 });
    expect(getBaseHourCapMicros('k1')).toBe(Math.floor((80 * $1) / 24));
  });

  it('returns null when uncapped', () => {
    expect(getBaseHourCapMicros('absent')).toBeNull();
  });
});

describe('getEffectiveHourCapMicros', () => {
  it('returns base + adjustment after settle initializes a fresh key', () => {
    setKey('k1', { dailyUsd: 240 }); // base = $10/hr
    const now = hourTs('2026-05-23T13:30:00');
    // First read settles from uninitialized (hour_ts=0): anchors to
    // current hour with adjustment=0, returns base.
    expect(getEffectiveHourCapMicros('k1', now)).toBe(10 * $1);
    // Row was updated.
    const r = getRow('k1');
    expect(r.adjustment_micros).toBe(0);
    expect(r.adjustment_hour_ts).toBe(hourTs('2026-05-23T13:00:00'));
  });

  it('returns null when uncapped (no settle attempted)', () => {
    expect(getEffectiveHourCapMicros('absent')).toBeNull();
  });

  it('back-compat alias getHourCapMicros routes through getEffectiveHourCapMicros', () => {
    setKey('k1', { dailyUsd: 240 });
    expect(getHourCapMicros('k1')).toBe(getEffectiveHourCapMicros('k1'));
  });

  it("user's H1→H2 example: underspend at H1, effective_cap drops at H2", () => {
    // Their numbers: base=$5/hr (= $120/day), start clean.
    // H1: spent=$7 → new_adj = 5 − 7 = −$2
    // H2: effective = base + adj = 5 − 2 = $3
    setKey('k1', {
      dailyUsd: 120,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    addSpend({
      ts: hourTs('2026-05-23T13:30:00'),
      costMicros: 7 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    // Settle at start of H2 (14:00).
    const nowH2 = hourTs('2026-05-23T14:30:00');
    const effH2 = getEffectiveHourCapMicros('k1', nowH2);
    expect(effH2).toBe(3 * $1);
    // Adjustment row updated to −$2.
    expect(getRow('k1').adjustment_micros).toBe(-2 * $1);
    expect(getRow('k1').adjustment_hour_ts).toBe(hourTs('2026-05-23T14:00:00'));
  });

  it("user's H2→H3 example: spent=2 under cap=3 → adj=+1", () => {
    // Continuing the example. H2 starts with adj=−2. Spent $2 in H2.
    // new_adj = (5 + −2) − 2 = +$1. H3 effective = 5 + 1 = $6.
    setKey('k1', {
      dailyUsd: 120,
      adjustmentUsd: -2,
      adjustmentHourTs: hourTs('2026-05-23T14:00:00'),
    });
    addSpend({
      ts: hourTs('2026-05-23T14:30:00'),
      costMicros: 2 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    const nowH3 = hourTs('2026-05-23T15:30:00');
    expect(getEffectiveHourCapMicros('k1', nowH3)).toBe(6 * $1);
    expect(getRow('k1').adjustment_micros).toBe(1 * $1);
    expect(getRow('k1').adjustment_hour_ts).toBe(hourTs('2026-05-23T15:00:00'));
  });

  it('settles many hours in a single SQL pass (app restart after long idle)', () => {
    // Base = $5/hr. Adjustment anchored to noon. Now is 10pm (10 hours
    // later). One hour had $10 of spend (overshoot by $5); the other 9
    // hours had no activity.
    //   total_allowed = 10 × 5 + 0 = $50
    //   total_spent   = $10
    //   new_adj       = $50 − $10 = $40 (accumulated underspend)
    setKey('k1', {
      dailyUsd: 120,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T12:00:00'),
    });
    addSpend({
      ts: hourTs('2026-05-23T14:30:00'),
      costMicros: 10 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    const now = hourTs('2026-05-23T22:30:00');
    expect(getEffectiveHourCapMicros('k1', now)).toBe(45 * $1); // base 5 + adj 40
    expect(getRow('k1').adjustment_micros).toBe(40 * $1);
  });

  it('idempotent within a single hour: re-reading does not double-count', () => {
    setKey('k1', {
      dailyUsd: 120,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    addSpend({
      ts: hourTs('2026-05-23T13:30:00'),
      costMicros: 7 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    const nowH2 = hourTs('2026-05-23T14:30:00');
    expect(getEffectiveHourCapMicros('k1', nowH2)).toBe(3 * $1);
    // Second call in the same hour shouldn't re-settle.
    expect(getEffectiveHourCapMicros('k1', nowH2)).toBe(3 * $1);
    expect(getEffectiveHourCapMicros('k1', nowH2)).toBe(3 * $1);
    expect(getRow('k1').adjustment_micros).toBe(-2 * $1);
  });

  it('effective cap can be negative when previous hour overshot massively', () => {
    // base = $1/hr, prev hour spent $100. new_adj = 1 − 100 = −$99.
    // Next hour's effective = 1 + (−99) = −$98.
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    addSpend({
      ts: hourTs('2026-05-23T13:30:00'),
      costMicros: 100 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    const nowH2 = hourTs('2026-05-23T14:30:00');
    expect(getEffectiveHourCapMicros('k1', nowH2)).toBe(-98 * $1);
  });

  it('positive adjustment accumulates without cap across many idle hours', () => {
    // User explicitly chose uncapped accumulation. After 168 idle
    // hours (1 week) on a $24/day key (base = $1/hr), adjustment
    // should reach 168 × $1 = $168.
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-16T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    expect(getEffectiveHourCapMicros('k1', now)).toBe(169 * $1); // base 1 + adj 168
    expect(getRow('k1').adjustment_micros).toBe(168 * $1);
  });
});

// ----- Spend queries ----------------------------------------------------

describe('spend queries', () => {
  it('currentHourSpendMicros sums only the current clock hour', () => {
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: hourTs('2026-05-23T12:45:00'), costMicros: 100 * $1, apiKeyId: 'k1' });
    addSpend({ ts: hourTs('2026-05-23T13:01:00'), costMicros: 1 * $1, apiKeyId: 'k1' });
    addSpend({ ts: hourTs('2026-05-23T13:59:00'), costMicros: 2 * $1, apiKeyId: 'k1' });
    expect(currentHourSpendMicros(now, 'k1')).toBe(3 * $1);
  });

  it('currentHourSpendMicros filters by api_key_id', () => {
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now - 60_000, costMicros: 5 * $1, apiKeyId: 'k1' });
    addSpend({ ts: now - 60_000, costMicros: 10 * $1, apiKeyId: 'k2' });
    expect(currentHourSpendMicros(now, 'k1')).toBe(5 * $1);
    expect(currentHourSpendMicros(now, 'k2')).toBe(10 * $1);
    expect(currentHourSpendMicros(now, null)).toBe(15 * $1);
  });

  it('todaySpendMicros sums the current local day only', () => {
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: hourTs('2026-05-22T23:59:00'), costMicros: 50 * $1, apiKeyId: 'k1' });
    addSpend({ ts: hourTs('2026-05-23T00:01:00'), costMicros: 5 * $1, apiKeyId: 'k1' });
    addSpend({ ts: hourTs('2026-05-23T13:00:00'), costMicros: 7 * $1, apiKeyId: 'k1' });
    expect(todaySpendMicros(now, 'k1')).toBe(12 * $1);
  });

  it('rollingDaySpendMicros sums the trailing 24h', () => {
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now - 23 * HOUR_MS, costMicros: 3 * $1, apiKeyId: 'k1' });
    addSpend({ ts: now - 25 * HOUR_MS, costMicros: 3 * $1, apiKeyId: 'k1' });
    expect(rollingDaySpendMicros(now, 'k1')).toBe(3 * $1);
  });
});

// ----- sessionHasCallInCurrentHour --------------------------------------

describe('sessionHasCallInCurrentHour', () => {
  it('returns true when session has any usage row in the current hour', () => {
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({
      ts: hourTs('2026-05-23T13:01:00'),
      costMicros: 1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    expect(sessionHasCallInCurrentHour('s1', now)).toBe(true);
  });

  it("returns false when the session's spend is in a different hour", () => {
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({
      ts: hourTs('2026-05-23T12:30:00'),
      costMicros: 1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    expect(sessionHasCallInCurrentHour('s1', now)).toBe(false);
  });

  it('does not leak across sessions on the same key', () => {
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({
      ts: hourTs('2026-05-23T13:01:00'),
      costMicros: 1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    expect(sessionHasCallInCurrentHour('s2', now)).toBe(false);
  });
});

// ----- precheckCall (the main decision tree) ----------------------------

describe('precheckCall', () => {
  it('Step 1: uncapped key → allow', () => {
    const r = precheckCall('s1', 'absent');
    expect(r.allowed).toBe(true);
    expect(r.capMicros).toBe(0);
  });

  it('Step 2: force-resume opens a 60-second grace window — multiple back-to-back calls all pass', () => {
    // The previous semantics were "one-shot bypass": a single click
    // released exactly ONE API call, which paused again on the
    // model's NEXT thinking step in the same turn. The user had to
    // spam the button. New semantics: 60s of bypass per click,
    // covering the whole multi-call agent turn.
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 's1' });
    setBypassNextTurn('s1', FORCE_RESUME_GRACE_MS, now);
    // Multiple calls within the window all pass.
    for (let i = 0; i < 5; i++) {
      const t = now + i * 1000; // 1s apart, all inside the 60s window
      const r = precheckCall('s1', 'k1', t);
      expect(r.allowed, `call ${i} at +${i}s`).toBe(true);
      expect(r.reason).toMatch(/force-resume grace/);
    }
  });

  it('Step 2: force-resume window EXPIRES after grace period; budget rules resume', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 's1' });
    setBypassNextTurn('s1', FORCE_RESUME_GRACE_MS, now);
    // Inside the window: allowed.
    const inWindow = precheckCall('s1', 'k1', now + FORCE_RESUME_GRACE_MS - 1);
    expect(inWindow.allowed).toBe(true);
    expect(inWindow.reason).toMatch(/force-resume grace/);
    // Past the window: budget rules apply again. Bucket is full and
    // s1 has prior calls this hour → blocked.
    const past = precheckCall('s1', 'k1', now + FORCE_RESUME_GRACE_MS + 1);
    expect(past.allowed).toBe(false);
    // The grace entry is lazy-cleaned on the first expired-window
    // probe, so getBypassUntil now reports undefined.
    expect(getBypassUntil('s1')).toBeUndefined();
  });

  it('Step 2: clicking force-resume twice REPLACES (does not stack) the timer', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const t0 = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: t0, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 's1' });
    // First click at t0 → expires at t0 + 60s.
    setBypassNextTurn('s1', 30_000, t0);
    expect(getBypassUntil('s1')).toBe(t0 + 30_000);
    // Second click at t0 + 10s → expires at t0 + 10 + 30 = t0 + 40s.
    // It does NOT extend to t0 + 60 (which would be cumulative).
    setBypassNextTurn('s1', 30_000, t0 + 10_000);
    expect(getBypassUntil('s1')).toBe(t0 + 40_000);
  });

  it('Step 2: force-resume on session A does NOT bypass session B', () => {
    // Each session has its own grace window. A user who clicks Force
    // Resume on the urgent session shouldn't accidentally let an
    // unrelated background session blow past its budget too.
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 'sA' });
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 'sB' });
    setBypassNextTurn('sA', FORCE_RESUME_GRACE_MS, now);
    expect(precheckCall('sA', 'k1', now).allowed).toBe(true);
    expect(precheckCall('sB', 'k1', now).allowed).toBe(false);
  });

  it('Step 3: bucket has room → allow', () => {
    setKey('k1', {
      dailyUsd: 240,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 3 * $1, apiKeyId: 'k1', sessionId: 's1' });
    const r = precheckCall('s1', 'k1', now);
    expect(r.allowed).toBe(true);
    expect(r.capMicros).toBe(10 * $1);
    expect(r.spentMicros).toBe(3 * $1);
  });

  it('Step 4: bucket exhausted, session has no prior call → exemption', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 'other' });
    const r = precheckCall('newSession', 'k1', now);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/exemption/);
  });

  it('Step 5: bucket exhausted AND session has prior call → block', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 5 * $1, apiKeyId: 'k1', sessionId: 's1' });
    const r = precheckCall('s1', 'k1', now);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/hour spend/);
    expect(r.spentMicros).toBe(5 * $1);
  });

  it('block reason names the effective cap (after carry-over), not base', () => {
    // base=$5, adj=−$3 → effective=$2. Spent $2 → blocked.
    setKey('k1', {
      dailyUsd: 120,
      adjustmentUsd: -3,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 2 * $1, apiKeyId: 'k1', sessionId: 's1' });
    const r = precheckCall('s1', 'k1', now);
    expect(r.allowed).toBe(false);
    expect(r.capMicros).toBe(2 * $1);
    expect(r.reason).toMatch(/effective cap 2\.00/);
  });

  it('exemption applies BEFORE block but not before room check', () => {
    setKey('k1', {
      dailyUsd: 240,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 1 * $1, apiKeyId: 'k1', sessionId: 'other' });
    const r = precheckCall('newSession', 'k1', now);
    expect(r.allowed).toBe(true);
    // Reason is empty (Step 3, "bucket has room"), not "exemption".
    expect(r.reason).toBe('');
  });

  it('per-key isolation: spend on key A does not block key B', () => {
    setKey('a', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    setKey('b', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    addSpend({ ts: now, costMicros: 100 * $1, apiKeyId: 'a', sessionId: 's1' });
    expect(precheckCall('s1', 'a', now).allowed).toBe(false);
    expect(precheckCall('s1', 'b', now).allowed).toBe(true);
  });

  it('nextRetryTs lands at the top of the next clock hour', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: 0,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:42:17.123');
    addSpend({
      ts: hourTs('2026-05-23T13:00:30'),
      costMicros: 5 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    const r = precheckCall('s1', 'k1', now);
    expect(r.allowed).toBe(false);
    expect(r.nextRetryTs).toBe(hourTs('2026-05-23T14:00:00'));
  });

  it('back-compat alias precheckTurn === precheckCall', () => {
    expect(precheckTurn).toBe(precheckCall);
  });

  it('Step 4 exemption fires even when effective cap is negative', () => {
    // Heavy carry-over overspend means effective cap is deeply negative.
    // A session that hasn't called this hour still gets its one call.
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: -50,
      adjustmentHourTs: hourTs('2026-05-23T13:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    const r = precheckCall('freshSession', 'k1', now);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/exemption/);
    expect(r.capMicros).toBeLessThan(0);
  });
});

// ----- resetBudgetAdjustment --------------------------------------------

describe('resetBudgetAdjustment', () => {
  it('zeros the adjustment and re-anchors to current hour', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: -47.5,
      adjustmentHourTs: hourTs('2026-05-23T10:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    resetBudgetAdjustment('k1', now);
    expect(getRow('k1').adjustment_micros).toBe(0);
    expect(getRow('k1').adjustment_hour_ts).toBe(hourTs('2026-05-23T13:00:00'));
  });

  it('after reset, the next effective cap is just base_hourly', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: -100,
      adjustmentHourTs: hourTs('2026-05-23T10:00:00'),
    });
    const now = hourTs('2026-05-23T13:30:00');
    resetBudgetAdjustment('k1', now);
    // No spend in current hour; effective = base = $1.
    expect(getEffectiveHourCapMicros('k1', now)).toBe(1 * $1);
  });

  it('does NOT delete usage_events rows (historical spend totals preserved)', () => {
    setKey('k1', {
      dailyUsd: 24,
      adjustmentUsd: -50,
      adjustmentHourTs: hourTs('2026-05-23T10:00:00'),
    });
    addSpend({
      ts: hourTs('2026-05-22T10:30:00'),
      costMicros: 30 * $1,
      apiKeyId: 'k1',
      sessionId: 's1',
    });
    resetBudgetAdjustment('k1', hourTs('2026-05-23T13:30:00'));
    // Spend history is untouched.
    expect(_spendRows).toHaveLength(1);
  });
});
