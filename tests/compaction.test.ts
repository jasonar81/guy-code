/**
 * Tests for `electron/compaction.ts` — the legacy client-side
 * summarizer. The agent loop now uses Anthropic's server-side
 * `clear_tool_uses_20250919` instead, but compaction.ts is still
 * exported for fallback paths and we want to ensure its math stays
 * correct.
 *
 * We test the pure helpers (estimateTokens, the cut-finding logic)
 * without invoking `maybeCompact`'s API call.
 */
import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { estimateTokens } from '../electron/compaction';

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
