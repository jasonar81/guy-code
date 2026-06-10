/**
 * Tests for `electron/pricing.ts`. Pure functions, no mocking needed.
 *
 * The pricing table is verified against Anthropic's public docs (May
 * 2026). The cost math is the part that's most likely to drift —
 * cache-write multipliers, model-family fallback, suffix stripping.
 */
import { describe, expect, it } from 'vitest';
import { getPricing, computeCostMicros } from '../electron/pricing';

const M = 1_000_000;

describe('getPricing', () => {
  it('returns exact-match table entries by model id', () => {
    const opus = getPricing('claude-opus-4-7');
    expect(opus.inputUsdPerMillion).toBe(5 * M);
    expect(opus.outputUsdPerMillion).toBe(25 * M);
  });

  it('Opus 4.8 uses $5/$25 (same as 4.7)', () => {
    const opus = getPricing('claude-opus-4-8');
    expect(opus.inputUsdPerMillion).toBe(5 * M);
    expect(opus.outputUsdPerMillion).toBe(25 * M);
  });

  it('Opus 4.8 with [1m] suffix uses $5/$25', () => {
    const opus = getPricing('claude-opus-4-8[1m]');
    expect(opus.inputUsdPerMillion).toBe(5 * M);
    expect(opus.outputUsdPerMillion).toBe(25 * M);
  });

  it('strips trailing [1m] suffix tags', () => {
    const opus = getPricing('claude-opus-4-7[1m]');
    expect(opus.inputUsdPerMillion).toBe(5 * M);
  });

  it('strips trailing date tags (claude-opus-4-7-20260301 → claude-opus-4-7)', () => {
    const opus = getPricing('claude-opus-4-7-20260301');
    expect(opus.inputUsdPerMillion).toBe(5 * M);
  });

  it('Opus 4 (legacy) uses $15/$75 rate', () => {
    const opus = getPricing('claude-opus-4');
    expect(opus.inputUsdPerMillion).toBe(15 * M);
    expect(opus.outputUsdPerMillion).toBe(75 * M);
  });

  it('Opus 3 (legacy) uses $15/$75 rate', () => {
    const opus = getPricing('claude-3-opus-20240229');
    expect(opus.inputUsdPerMillion).toBe(15 * M);
    expect(opus.outputUsdPerMillion).toBe(75 * M);
  });

  it('Sonnet uses $3/$15', () => {
    const sonnet = getPricing('claude-sonnet-4-5');
    expect(sonnet.inputUsdPerMillion).toBe(3 * M);
    expect(sonnet.outputUsdPerMillion).toBe(15 * M);
  });

  it('Haiku 4.5 uses $1/$5', () => {
    const haiku = getPricing('claude-haiku-4-5');
    expect(haiku.inputUsdPerMillion).toBe(1 * M);
    expect(haiku.outputUsdPerMillion).toBe(5 * M);
  });

  it('cache-read costs 0.10× input', () => {
    const opus = getPricing('claude-opus-4-7');
    expect(opus.cacheReadUsdPerMillion).toBe(0.5 * M);
  });

  it('cache-write 5min costs 1.25× input', () => {
    const opus = getPricing('claude-opus-4-7');
    expect(opus.cacheWrite5mUsdPerMillion).toBe(6.25 * M);
  });

  it('cache-write 1hour costs 2.0× input', () => {
    const opus = getPricing('claude-opus-4-7');
    expect(opus.cacheWrite1hUsdPerMillion).toBe(10 * M);
  });

  it('falls back to opus family pricing for unknown opus model ids', () => {
    const p = getPricing('claude-opus-4-99-experimental');
    expect(p.inputUsdPerMillion).toBe(5 * M); // modern Opus rate
  });

  it('falls back to haiku family pricing for unknown haiku model ids', () => {
    const p = getPricing('claude-haiku-9000');
    expect(p.inputUsdPerMillion).toBe(1 * M);
  });

  it('falls back to sonnet pricing for unknown models naming the sonnet family', () => {
    const p = getPricing('claude-sonnet-9000-experimental');
    expect(p.inputUsdPerMillion).toBe(3 * M);
    expect(p.outputUsdPerMillion).toBe(15 * M);
  });

  it('falls back to Opus-class $5/$25 for an unknown model that names no known family', () => {
    // Default model is Opus; a brand-new Anthropic flagship whose alias we
    // haven't tabled yet is far more likely Opus-priced than Sonnet-priced.
    // Erring high avoids silently under-reporting spend on an expensive model.
    const p = getPricing('totally-fake-model');
    expect(p.inputUsdPerMillion).toBe(5 * M);
    expect(p.outputUsdPerMillion).toBe(25 * M);
  });
});

describe('computeCostMicros', () => {
  it('returns 0 for zero usage', () => {
    expect(
      computeCostMicros('claude-opus-4-7', {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 0,
      })
    ).toBe(0);
  });

  it('charges $5 / 1M input tokens for Opus 4.7', () => {
    const cost = computeCostMicros('claude-opus-4-7', {
      inputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(5 * M); // $5 in micros
  });

  it('charges $25 / 1M output tokens for Opus 4.7', () => {
    const cost = computeCostMicros('claude-opus-4-7', {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(25 * M);
  });

  it('charges 1h cache writes at 2× input rate', () => {
    const cost = computeCostMicros('claude-opus-4-7', {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(cost).toBe(10 * M); // $10 in micros
  });

  it('charges cache reads at 0.10× input rate', () => {
    const cost = computeCostMicros('claude-opus-4-7', {
      inputTokens: 0,
      cacheReadTokens: 10_000_000, // 10M cache-read tokens
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(5 * M); // 10M tokens × $0.50/M = $5
  });

  it('sums all five components correctly for a realistic agent turn', () => {
    // Realistic small agent turn: 5K input, 50K cache-read, 0 5m, 5K
    // 1h-write, 800 output. Opus 4.7 prices: $5 input, $25 output.
    // Expected cost (in dollars):
    //   5K input × $5/M = $0.025
    //   50K read × $0.50/M = $0.025
    //   5K 1h-write × $10/M = $0.05
    //   800 output × $25/M = $0.020
    //   Total = $0.12
    const cost = computeCostMicros('claude-opus-4-7', {
      inputTokens: 5_000,
      cacheReadTokens: 50_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 5_000,
      outputTokens: 800,
    });
    expect(cost).toBe(120_000); // $0.12
  });

  it('rounds half-cents to nearest integer micro', () => {
    // Construct an input that produces a fractional micro.
    // 1 token of input on opus-4-7 = 5/1M = 0.000005 dollars = 5 micros.
    // 0.5 tokens isn't a real input, but the calculation should round.
    const cost = computeCostMicros('claude-opus-4-7', {
      inputTokens: 1,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(5);
  });
});

describe('Claude Fable 5 pricing + default', () => {
  it('prices claude-fable-5 at $10 input / $50 output with standard cache multipliers', () => {
    const p = getPricing('claude-fable-5');
    expect(p.inputUsdPerMillion).toBe(10 * 1_000_000);
    expect(p.outputUsdPerMillion).toBe(50 * 1_000_000);
    // cache read 0.1x ($1), 5m write 1.25x ($12.50), 1h write 2x ($20)
    expect(p.cacheReadUsdPerMillion).toBe(1 * 1_000_000);
    expect(p.cacheWrite5mUsdPerMillion).toBe(12.5 * 1_000_000);
    expect(p.cacheWrite1hUsdPerMillion).toBe(20 * 1_000_000);
  });

  it('prices claude-fable-5[1m] the same (strips the context tag)', () => {
    const a = getPricing('claude-fable-5');
    const b = getPricing('claude-fable-5[1m]');
    expect(b).toEqual(a);
  });

  it('does NOT fall back to the $5/$25 opus default for fable (explicit entry required)', () => {
    const p = getPricing('claude-fable-5');
    expect(p.inputUsdPerMillion).not.toBe(5 * 1_000_000);
  });

  it('DEFAULT_MODEL is claude-fable-5[1m] and DEFAULT_EFFORT is xhigh', async () => {
    const { DEFAULT_MODEL, DEFAULT_EFFORT } = await import('../electron/anthropic');
    expect(DEFAULT_MODEL).toBe('claude-fable-5[1m]');
    expect(DEFAULT_EFFORT).toBe('xhigh');
  });
});

describe('refusal fallback config', () => {
  it('exports REFUSAL_FALLBACK_MODEL as opus-4-8[1m] and keeps fable as default', async () => {
    const { DEFAULT_MODEL, REFUSAL_FALLBACK_MODEL } = await import('../electron/anthropic');
    expect(DEFAULT_MODEL).toBe('claude-fable-5[1m]');
    expect(REFUSAL_FALLBACK_MODEL).toBe('claude-opus-4-8[1m]');
    // The fallback must differ from the default so a refusal actually switches.
    expect(REFUSAL_FALLBACK_MODEL).not.toBe(DEFAULT_MODEL);
  });

  it('the fallback model is priced correctly (opus 4.8 = $5/$25)', async () => {
    const opus = getPricing('claude-opus-4-8');
    expect(opus.inputUsdPerMillion).toBe(5 * 1_000_000);
    expect(opus.outputUsdPerMillion).toBe(25 * 1_000_000);
  });
});
