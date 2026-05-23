/**
 * Tests for `electron/ephemeralize.ts` — the legacy client-side
 * tool-output ephemeralization tier system. Server-side micro-
 * compaction has largely replaced this in production code paths,
 * but the helper is still exported and we want its semantics pinned
 * down (tier1 = verbatim recent/latest, tier2 = synopsis, tier3 =
 * drop too-large).
 */
import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ephemeralizeMessages } from '../electron/ephemeralize';

function bashUse(id: string): any {
  return { type: 'tool_use', id, name: 'Bash', input: { cmd: 'ls' } };
}
function bashResult(id: string, content: string, isError = false): any {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content,
    is_error: isError,
  };
}
function userTurn(blocks: any[]): Anthropic.MessageParam {
  return { role: 'user', content: blocks };
}
function assistantTurn(blocks: any[]): Anthropic.MessageParam {
  return { role: 'assistant', content: blocks };
}

describe('ephemeralizeMessages', () => {
  it('passes through messages with no tool_results untouched', () => {
    const msgs: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(ephemeralizeMessages(msgs)).toEqual(msgs);
  });

  it('keeps the LATEST tool_result for each tool name verbatim', () => {
    const msgs: Anthropic.MessageParam[] = [
      assistantTurn([bashUse('u1')]),
      userTurn([bashResult('u1', 'old output')]),
      assistantTurn([bashUse('u2')]),
      userTurn([bashResult('u2', 'newest output')]),
    ];
    const out = ephemeralizeMessages(msgs);
    // The most recent Bash tool_result is left as-is.
    const lastUser = out[out.length - 1] as any;
    expect(lastUser.content[0].content).toBe('newest output');
  });

  it('synopsifies older tool_results that are not the latest of their tool name', () => {
    // Make many bash turns so the older one falls outside the recent
    // window AND isn't the latest for its tool.
    const msgs: Anthropic.MessageParam[] = [];
    for (let i = 1; i <= 8; i++) {
      msgs.push(assistantTurn([bashUse(`u${i}`)]));
      msgs.push(userTurn([bashResult(`u${i}`, `output ${i}`)]));
    }
    const out = ephemeralizeMessages(msgs);
    // The first bash result should be replaced by a synopsis because
    // it's neither the latest of its tool nor in the recent-tail
    // window.
    const firstResult = (out[1] as any).content[0];
    expect(firstResult.content).toMatch(/^\[Bash#1.*ref:tr_[0-9a-f]{8}\]/);
  });

  it('drops oversize tool_results (>32KB) with a [dropped] hint', () => {
    const huge = 'x'.repeat(40 * 1024);
    const msgs: Anthropic.MessageParam[] = [
      assistantTurn([bashUse('u1')]),
      userTurn([bashResult('u1', huge)]),
      assistantTurn([bashUse('u2')]),
      userTurn([bashResult('u2', 'small fresh output')]),
    ];
    const out = ephemeralizeMessages(msgs);
    const firstResult = (out[1] as any).content[0];
    expect(firstResult.content).toContain('[dropped: too large]');
  });

  it('marks errors with " error" tag in the synopsis', () => {
    const msgs: Anthropic.MessageParam[] = [];
    for (let i = 1; i <= 8; i++) {
      msgs.push(assistantTurn([bashUse(`u${i}`)]));
      msgs.push(userTurn([bashResult(`u${i}`, `output ${i}`, i === 1)])); // first one errored
    }
    const out = ephemeralizeMessages(msgs);
    const firstResult = (out[1] as any).content[0];
    expect(firstResult.content).toMatch(/^\[Bash#1 error/);
  });

  it('produces deterministic synopsis hashes (cache-friendly)', () => {
    // Two identical inputs should produce identical outputs (no time-
    // dependent state in the synopsis hash).
    const make = () => {
      const msgs: Anthropic.MessageParam[] = [];
      for (let i = 1; i <= 8; i++) {
        msgs.push(assistantTurn([bashUse(`u${i}`)]));
        msgs.push(userTurn([bashResult(`u${i}`, `output ${i}`)]));
      }
      return msgs;
    };
    const a = ephemeralizeMessages(make());
    const b = ephemeralizeMessages(make());
    expect(a).toEqual(b);
  });

  it('does not mutate the input array', () => {
    const msgs: Anthropic.MessageParam[] = [];
    for (let i = 1; i <= 8; i++) {
      msgs.push(assistantTurn([bashUse(`u${i}`)]));
      msgs.push(userTurn([bashResult(`u${i}`, `output ${i}`)])); 
    }
    const original = JSON.stringify(msgs);
    ephemeralizeMessages(msgs);
    expect(JSON.stringify(msgs)).toBe(original);
  });
});
