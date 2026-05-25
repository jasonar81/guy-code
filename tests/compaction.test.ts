/**
 * Tests for `electron/compaction.ts`.
 *
 * The agent loop relies on a layered defense for context-overflow:
 *
 *   1. **Server-side micro-compaction** (Anthropic's
 *      `clear_tool_uses_20250919`) handles routine tool-result decay.
 *
 *   2. **Pre-flight** (`preflightCompactIfNeeded`) shrinks before each
 *      send when our token estimate exceeds 95% of the model's cap.
 *
 *   3. **Emergency recovery** (`emergencyCompact` + the 400 retry in
 *      `agent.ts`) ephemeralizes huge tool_results AND aggressively
 *      compacts when the API has actually rejected with
 *      `prompt is too long`.
 *
 * These tests cover the pure helpers and the error-pattern detector.
 * Network paths (the haiku summarizer in `maybeCompact`) are mocked
 * out by stubbing `getApiKey` to null so the summarizer short-circuits
 * to its no-key fallback (truncate-with-placeholder).
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  estimateTokens,
  isPromptTooLongError,
  preflightCompactIfNeeded,
  emergencyCompact,
} from '../electron/compaction';

vi.mock('../electron/secret', () => ({
  getApiKey: () => null,
}));

describe('estimateTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('approximates 4 chars per token for plain string content', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'a'.repeat(40) }, // 40 chars → 10 tokens
    ];
    expect(estimateTokens(msgs)).toBe(10);
  });

  it('walks block content arrays', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a'.repeat(8) },
          { type: 'text', text: 'b'.repeat(8) },
        ],
      } as any,
    ];
    expect(estimateTokens(msgs)).toBe(4); // 16 chars / 4
  });

  it('uses tool_result content string when present', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'x'.repeat(20),
          },
        ],
      } as any,
    ];
    expect(estimateTokens(msgs)).toBe(5); // 20 / 4
  });

  it('falls back to JSON.stringify length for unknown blocks', () => {
    const msgs: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'X', id: 'a', input: { k: 'v' } }],
      } as any,
    ];
    // JSON.stringify of the block produces a non-zero count.
    expect(estimateTokens(msgs)).toBeGreaterThan(0);
  });

  it('rounds up partial tokens (ceil)', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'abc' }, // 3 chars / 4 = 0.75 → 1 token
    ];
    expect(estimateTokens(msgs)).toBe(1);
  });
});

// ---- isPromptTooLongError ----------------------------------------------

describe('isPromptTooLongError', () => {
  it('returns hit=false for falsy values', () => {
    expect(isPromptTooLongError(null)).toEqual({ hit: false, tokens: 0 });
    expect(isPromptTooLongError(undefined)).toEqual({ hit: false, tokens: 0 });
    expect(isPromptTooLongError('')).toEqual({ hit: false, tokens: 0 });
  });

  it('returns hit=false for unrelated errors', () => {
    expect(isPromptTooLongError(new Error('ECONNRESET'))).toEqual({
      hit: false,
      tokens: 0,
    });
    expect(
      isPromptTooLongError(new Error('rate_limit_error: too many requests'))
    ).toEqual({ hit: false, tokens: 0 });
  });

  it('detects the canonical Anthropic 400 message and parses tokens', () => {
    // The exact shape the user pasted in their bug report.
    const e = new Error(
      `400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1008265 tokens > 1000000 maximum"},"request_id":"req_011CbLnSJTyXGrDL22jKDVRU"}`
    );
    const r = isPromptTooLongError(e);
    expect(r.hit).toBe(true);
    expect(r.tokens).toBe(1008265);
  });

  it('handles 200K-cap variant', () => {
    const e = new Error(
      `400 prompt is too long: 215000 tokens > 200000 maximum`
    );
    expect(isPromptTooLongError(e)).toEqual({ hit: true, tokens: 215000 });
  });

  it('returns tokens=0 when message lacks a parseable number', () => {
    const e = new Error('prompt is too long');
    expect(isPromptTooLongError(e)).toEqual({ hit: true, tokens: 0 });
  });

  it('accepts plain string errors (some SDK transports throw strings)', () => {
    const r = isPromptTooLongError(
      'prompt is too long: 1234567 tokens > 1000000 maximum'
    );
    expect(r.hit).toBe(true);
    expect(r.tokens).toBe(1234567);
  });
});

// ---- preflightCompactIfNeeded ------------------------------------------

/**
 * Build a synthetic message array of approximately the requested
 * token count. Each message is a verbose user prompt of `chars`
 * characters; the helper produces enough messages to total `targetTokens`.
 *
 * We keep messages under 4000 chars each (Anthropic API limit on
 * single-block content is much higher, but the smaller blocks
 * exercise the cut-finding logic — many small messages, not one
 * huge one).
 */
function buildLargeHistory(targetTokens: number): Anthropic.MessageParam[] {
  const chars = 4000;
  const tokensPerMsg = chars / 4; // 1000 tokens
  const count = Math.ceil(targetTokens / tokensPerMsg);
  const out: Anthropic.MessageParam[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}: ` + 'x'.repeat(chars - 5),
    });
  }
  return out;
}

describe('preflightCompactIfNeeded', () => {
  it('returns input unchanged when under safety threshold (200K model)', async () => {
    const msgs = buildLargeHistory(50_000); // well under 190K safety
    const out = await preflightCompactIfNeeded(msgs, 'claude-sonnet-4-5');
    expect(out).toBe(msgs); // same reference
  });

  it('returns input unchanged when under safety threshold (1M model)', async () => {
    const msgs = buildLargeHistory(500_000); // well under 950K safety
    const out = await preflightCompactIfNeeded(msgs, 'claude-opus-4-7[1m]');
    expect(out).toBe(msgs);
  });

  it('compacts when over safety threshold (1M model)', async () => {
    // 970K tokens > 950K safety → fires.
    const msgs = buildLargeHistory(970_000);
    const out = await preflightCompactIfNeeded(msgs, 'claude-opus-4-7[1m]');
    // Compaction MUST shrink the array (head replaced with summary or
    // truncate-with-placeholder; tail stays).
    expect(out.length).toBeLessThan(msgs.length);
    expect(estimateTokens(out)).toBeLessThan(estimateTokens(msgs));
  });

  it('compacts when over safety threshold (200K model)', async () => {
    // 195K > 190K safety → fires.
    const msgs = buildLargeHistory(195_000);
    const out = await preflightCompactIfNeeded(msgs, 'claude-sonnet-4-5');
    expect(out.length).toBeLessThan(msgs.length);
  });

  it('uses the 1M cap when model carries [1m] suffix', async () => {
    // 250K is over the 200K cap but under the 1M cap. Without
    // parseExtendedContext recognizing [1m], we'd erroneously compact
    // a perfectly fine 1M-context payload.
    const msgs = buildLargeHistory(250_000);
    const out = await preflightCompactIfNeeded(msgs, 'claude-opus-4-7[1m]');
    expect(out).toBe(msgs); // no compaction
  });
});

// ---- emergencyCompact --------------------------------------------------

describe('emergencyCompact', () => {
  it('returns empty array unchanged', async () => {
    const out = await emergencyCompact([]);
    expect(out).toEqual([]);
  });

  it('ephemeralizes a single huge tool_result without needing the summarizer', async () => {
    // Pathological case: one assistant tool_use + one user tool_result
    // that's 200KB of text. ephemeralizeMessages alone should
    // truncate it to a synopsis. maybeCompact (stage 2) will skip
    // because messages.length is too small to safely cut.
    const huge = 'x'.repeat(200 * 1024);
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'do the thing' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: '/big' } },
        ] as any,
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: huge }] as any,
      },
    ];
    const before = estimateTokens(msgs);
    const out = await emergencyCompact(msgs);
    const after = estimateTokens(out);
    // The 200KB tool_result is way over `DROP_OVER_BYTES` (32KB) so
    // ephemeralization replaces it with a synopsis like
    // `[Read#1 200KB ref:tr_...] [dropped: too large]`. Ratio
    // should be at least ~95% reduction.
    expect(after).toBeLessThan(Math.floor(before * 0.1));
    // The sanitizer-relevant structure (tool_use → tool_result pair)
    // must be preserved so the API doesn't reject the retry with an
    // unrelated tool-pairing error.
    expect(out).toHaveLength(3);
    expect((out[1].content as any[])[0].type).toBe('tool_use');
    expect((out[2].content as any[])[0].type).toBe('tool_result');
  });

  it('compacts the head when there are enough messages', async () => {
    // 60 messages total — enough that the verbatim tail (last ~20
    // after emergency tightens KEEP_RECENT_TURNS_MAX) plus the
    // truncate-with-placeholder head is meaningfully smaller.
    const msgs = buildLargeHistory(50_000); // ~50 msgs
    const before = msgs.length;
    const out = await emergencyCompact(msgs);
    expect(out.length).toBeLessThan(before);
    // Last message should be preserved verbatim — that's the user's
    // current turn and losing it would force the model to ask "what
    // did you say?".
    expect(out[out.length - 1]).toEqual(msgs[msgs.length - 1]);
  });

  it('preserves tool_use/tool_result pairing across the compaction boundary', async () => {
    // Build a history where every other message is a tool round.
    // After compaction we should never see a tool_result whose
    // matching tool_use was summarized away (or vice versa) — that
    // would cause sanitizeMessages downstream to drop the orphan,
    // and on the retry the model would lose tool-call context.
    const msgs: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 80; i++) {
      msgs.push({ role: 'user', content: `user turn ${i}: ${'a'.repeat(2000)}` });
      msgs.push({
        role: 'assistant',
        content: [
          { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { cmd: 'ls' } },
        ] as any,
      });
      msgs.push({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: `t${i}`, content: `out ${i}` },
        ] as any,
      });
    }
    const out = await emergencyCompact(msgs);
    // Walk the output and check every tool_result has a matching
    // tool_use in the immediately-preceding assistant message.
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (m.role !== 'user' || !Array.isArray(m.content)) continue;
      for (const b of m.content as any[]) {
        if (b?.type !== 'tool_result') continue;
        const prev = out[i - 1];
        expect(prev?.role).toBe('assistant');
        expect(Array.isArray(prev?.content)).toBe(true);
        const ids = (prev!.content as any[])
          .filter((x) => x?.type === 'tool_use')
          .map((x) => x.id);
        expect(ids).toContain(b.tool_use_id);
      }
    }
  });
});
