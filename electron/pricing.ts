// Pricing table. Per-million-token cost expressed in USD micros (1 USD = 1_000_000 micros).
//
// Pattern (matches Anthropic's published cache-pricing multipliers):
//   cacheRead     = 0.10 * input
//   cacheWrite5m  = 1.25 * input
//   cacheWrite1h  = 2.00 * input
//
// If the model is not in the table, we fall back to a "best guess" by family
// (opus / sonnet / haiku) and log a warning.

export interface ModelPricing {
  inputUsdPerMillion: number;       // micros per million input tokens
  outputUsdPerMillion: number;      // micros per million output tokens
  cacheReadUsdPerMillion: number;
  cacheWrite5mUsdPerMillion: number;
  cacheWrite1hUsdPerMillion: number;
}

const M = 1_000_000; // micros per dollar

function pricing(input: number, output: number): ModelPricing {
  return {
    inputUsdPerMillion: input * M,
    outputUsdPerMillion: output * M,
    cacheReadUsdPerMillion: input * M * 0.1,
    cacheWrite5mUsdPerMillion: input * M * 1.25,
    cacheWrite1hUsdPerMillion: input * M * 2.0,
  };
}

// Per-million-token prices in USD. Verified against Anthropic's public
// pricing page in May 2026. Opus 4.5 onward is $5/$25 — Anthropic dropped
// Opus from the prior $15/$75 to broaden agentic use; Opus 4.7 (released
// April 2026) kept that pricing. Earlier Opus 4 / Claude 3 Opus retain
// the legacy $15/$75 rate.
const TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-7': pricing(5, 25),
  'claude-opus-4-7-1m': pricing(5, 25),
  'claude-opus-4-6': pricing(5, 25),
  'claude-opus-4-5': pricing(5, 25),
  'claude-opus-4': pricing(15, 75),
  'claude-sonnet-4-6': pricing(3, 15),
  'claude-sonnet-4-5': pricing(3, 15),
  'claude-sonnet-4': pricing(3, 15),
  'claude-haiku-4-5': pricing(1, 5),
  'claude-haiku-4': pricing(1, 5),
  'claude-3-7-sonnet-20250219': pricing(3, 15),
  'claude-3-5-sonnet-20241022': pricing(3, 15),
  'claude-3-5-haiku-20241022': pricing(0.8, 4),
  'claude-3-opus-20240229': pricing(15, 75),
};

function familyFallback(model: string): ModelPricing {
  const lc = model.toLowerCase();
  // Opus family fallback uses the modern $5/$25 rate. Older models that
  // need the legacy $15/$75 are listed explicitly above; if a user pins
  // a deprecated build via custom string, the cost report will be a
  // slight underestimate — acceptable tradeoff for not over-charging
  // current users.
  if (lc.includes('opus')) return pricing(5, 25);
  if (lc.includes('haiku')) return pricing(1, 5);
  return pricing(3, 15); // sonnet default
}

export function getPricing(model: string): ModelPricing {
  // Strip suffix tags like "[1m]"
  const stripped = model.replace(/\[.*?\]$/, '').trim();
  // Try exact match
  if (TABLE[stripped]) return TABLE[stripped];
  // Try without trailing date tag (claude-opus-4-7-20260301 → claude-opus-4-7)
  const noDate = stripped.replace(/-\d{8}$/, '');
  if (TABLE[noDate]) return TABLE[noDate];
  // Family fallback
  return familyFallback(stripped);
}

export interface UsageInput {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
}

/** Returns cost in USD micros (integer). */
export function computeCostMicros(model: string, u: UsageInput): number {
  const p = getPricing(model);
  const c =
    (u.inputTokens * p.inputUsdPerMillion) / 1_000_000 +
    (u.cacheReadTokens * p.cacheReadUsdPerMillion) / 1_000_000 +
    (u.cacheWrite5mTokens * p.cacheWrite5mUsdPerMillion) / 1_000_000 +
    (u.cacheWrite1hTokens * p.cacheWrite1hUsdPerMillion) / 1_000_000 +
    (u.outputTokens * p.outputUsdPerMillion) / 1_000_000;
  return Math.round(c);
}
