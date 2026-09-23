/**
 * Every model entry checked against Anthropic's published pricing table.
 *
 * The table's cache columns are the easy thing to get wrong: the helper derives
 * them from the input price with 0.1x / 1.25x / 2x multipliers, and per the
 * published footnotes THREE models break that -
 *   Fable 5.1 and Mythos 5.1 charge 0.025x for a cache hit,
 *   Opus 5.5 charges 0.05x,
 *   everything else uses the standard 0.1x.
 * These tests pin the real numbers so a future edit can't silently re-derive
 * (and mis-bill) them.
 */
import { describe, expect, it } from 'vitest';
import { getPricing } from '../electron/pricing';

const M = 1_000_000;

/** input, 5m write, 1h write, cache hit, output - straight from the table. */
const PUBLISHED: Array<[string, number, number, number, number, number]> = [
  ['claude-fable-5-1', 10, 12.5, 20, 0.25, 50],
  ['claude-mythos-5-1', 10, 12.5, 20, 0.25, 50],
  ['claude-fable-5', 10, 12.5, 20, 1, 50],
  ['claude-mythos-5', 10, 12.5, 20, 1, 50],
  ['claude-opus-5-5', 4, 5, 8, 0.2, 20],
  ['claude-opus-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-8', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-7', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-6', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-5', 5, 6.25, 10, 0.5, 25],
  ['claude-opus-4-1', 15, 18.75, 30, 1.5, 75],
  ['claude-opus-4', 15, 18.75, 30, 1.5, 75],
  ['claude-sonnet-5', 2, 2.5, 4, 0.2, 10],
  ['claude-sonnet-4-6', 3, 3.75, 6, 0.3, 15],
  ['claude-sonnet-4-5', 3, 3.75, 6, 0.3, 15],
  ['claude-sonnet-4', 3, 3.75, 6, 0.3, 15],
  ['claude-haiku-4-5', 1, 1.25, 2, 0.1, 5],
];

describe('published pricing table', () => {
  for (const [model, input, w5m, w1h, hit, output] of PUBLISHED) {
    it(`${model}: $${input}/$${output} in-out, $${hit} cache hit`, () => {
      const p = getPricing(model);
      expect(p.inputUsdPerMillion).toBeCloseTo(input * M, 0);
      expect(p.outputUsdPerMillion).toBeCloseTo(output * M, 0);
      expect(p.cacheReadUsdPerMillion).toBeCloseTo(hit * M, 0);
      expect(p.cacheWrite5mUsdPerMillion).toBeCloseTo(w5m * M, 0);
      expect(p.cacheWrite1hUsdPerMillion).toBeCloseTo(w1h * M, 0);
    });
  }
});

describe('the models whose cache hits break the 0.1x multiplier', () => {
  it('Fable 5.1 charges 0.025x input for a cache hit, not 0.1x', () => {
    const p = getPricing('claude-fable-5-1');
    expect(p.cacheReadUsdPerMillion).toBe(0.25 * M);
    expect(p.cacheReadUsdPerMillion).not.toBe(10 * M * 0.1); // the derived $1
  });

  it('Mythos 5.1 matches Fable 5.1', () => {
    const p = getPricing('claude-mythos-5-1');
    expect(p.cacheReadUsdPerMillion).toBe(0.25 * M);
  });

  it('Opus 5.5 charges 0.05x input for a cache hit', () => {
    const p = getPricing('claude-opus-5-5');
    expect(p.cacheReadUsdPerMillion).toBe(0.2 * M);
    expect(p.cacheReadUsdPerMillion).not.toBe(4 * M * 0.1);
  });

  it('Fable 5 (the older one) still uses the standard 0.1x', () => {
    const p = getPricing('claude-fable-5');
    expect(p.cacheReadUsdPerMillion).toBe(1 * M);
  });

  it('Sonnet 5 uses the standard 0.1x (its $0.20 IS 10% of $2)', () => {
    const p = getPricing('claude-sonnet-5');
    expect(p.cacheReadUsdPerMillion).toBe(0.2 * M);
  });
});

describe('[1m] variants resolve to the same rates', () => {
  for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5']) {
    it(`${id}[1m] matches ${id}`, () => {
      expect(getPricing(`${id}[1m]`)).toEqual(getPricing(id));
    });
  }
});

describe('models offered in the per-session picker are priced explicitly', () => {
  // If one of these ever fell through to the family fallback the cost report
  // would be wrong for a model the user can select in two clicks.
  it('Opus 5.5 and Fable 5.1 are both exact table hits', () => {
    // A family fallback for "fable" would return the Opus $5/$25 default.
    expect(getPricing('claude-fable-5-1[1m]').inputUsdPerMillion).toBe(10 * M);
    expect(getPricing('claude-opus-5-5[1m]').inputUsdPerMillion).toBe(4 * M);
  });
});

describe('legacy Opus keeps the pre-cut price', () => {
  it('Opus 4.1 is $15/$75, NOT the $5/$25 family fallback', () => {
    const p = getPricing('claude-opus-4-1');
    expect(p.inputUsdPerMillion).toBe(15 * M);
    expect(p.outputUsdPerMillion).toBe(75 * M);
  });
});
