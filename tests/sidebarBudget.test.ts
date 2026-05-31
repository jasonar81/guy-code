/**
 * Tests for `shouldShowRichBudget` — the gate that decides whether the
 * sidebar shows the rich "this hour / today" budget view vs the bare
 * "24h: $X" fallback.
 *
 * The bug this guards against: the effective hourly cap (`hourCapMicros`)
 * goes NEGATIVE once a key accumulates overspend. The old gate treated
 * `hourCapMicros <= 0` the same as "no budget", so an over-budget key with
 * a real daily budget silently lost its hourly + daily numbers. The gate
 * must key off whether a budget is CONFIGURED (daily / base hour cap), not
 * the effective cap.
 */
import { describe, expect, it } from 'vitest';
import { shouldShowRichBudget, computeHourBudget } from '../src/components/Sidebar';
import type { BudgetStatus } from '../src/types';

const base: BudgetStatus = {
  apiKeyId: 'k1',
  hourCapMicros: 95_000_000,
  baseHourCapMicros: 95_000_000,
  hourSpentMicros: 0,
  dailyCapMicros: 2_300_000_000,
  daySpentMicros: 0,
  last24hSpentMicros: 0,
};

describe('shouldShowRichBudget', () => {
  it('returns false for a null budget', () => {
    expect(shouldShowRichBudget(null)).toBe(false);
  });

  it('returns false when no budget is configured (all caps null)', () => {
    expect(
      shouldShowRichBudget({
        ...base,
        hourCapMicros: null,
        baseHourCapMicros: null,
        dailyCapMicros: null,
      })
    ).toBe(false);
  });

  it('returns true for a normally-budgeted key', () => {
    expect(shouldShowRichBudget(base)).toBe(true);
  });

  it('★ returns true for an OVER-BUDGET key (effective hourCap negative)', () => {
    // This is the exact regression: Jason's Default key, $2,300/day budget,
    // ~$3.2k/24h spend → carryover drove the effective hourly cap negative.
    // It must STILL show the rich view (the daily budget is configured).
    expect(
      shouldShowRichBudget({
        ...base,
        hourCapMicros: -50_000_000, // negative effective cap = over budget
        baseHourCapMicros: 95_000_000,
        dailyCapMicros: 2_300_000_000,
      })
    ).toBe(true);
  });

  it('returns true when only a base hour cap is present (daily null)', () => {
    expect(
      shouldShowRichBudget({
        ...base,
        dailyCapMicros: null,
        baseHourCapMicros: 10_000_000,
        hourCapMicros: -5_000_000,
      })
    ).toBe(true);
  });

  it('returns false when daily cap is zero / non-positive', () => {
    expect(
      shouldShowRichBudget({
        ...base,
        dailyCapMicros: 0,
        baseHourCapMicros: null,
        hourCapMicros: null,
      })
    ).toBe(false);
  });
});

describe('computeHourBudget', () => {
  const base = {
    apiKeyId: 'k1',
    hourCapMicros: 95_000_000,
    baseHourCapMicros: 95_000_000,
    hourSpentMicros: 0,
    dailyCapMicros: 2_300_000_000,
    daySpentMicros: 0,
    last24hSpentMicros: 0,
  };

  it('positive effective cap, $0 spent -> NOT over (the v0.1.17 regression)', () => {
    const r = computeHourBudget({ ...base, hourCapMicros: 95_000_000, hourSpentMicros: 0 });
    expect(r.overHour).toBe(false);
    expect(r.effHourCap).toBe(95_000_000);
    expect(r.hourPct).toBe(0);
  });

  it('NEGATIVE effective cap (carryover deficit), $0 spent -> over, denom stays negative', () => {
    const r = computeHourBudget({ ...base, hourCapMicros: -210_000_000, hourSpentMicros: 0 });
    expect(r.overHour).toBe(true);
    expect(r.effHourCap).toBe(-210_000_000);
    expect(r.hourPct).toBe(1);
  });

  it('positive cap, spend exceeds it -> over', () => {
    const r = computeHourBudget({ ...base, hourCapMicros: 95_000_000, hourSpentMicros: 100_000_000 });
    expect(r.overHour).toBe(true);
  });

  it('null effective cap treated as 0', () => {
    const r = computeHourBudget({ ...base, hourCapMicros: null, hourSpentMicros: 0 });
    expect(r.effHourCap).toBe(0);
    expect(r.overHour).toBe(false);
  });
});
