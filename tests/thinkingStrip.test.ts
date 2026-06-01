/**
 * Tests for thinking-block stripping in `electron/sessionRuntime.ts`.
 *
 * Bug fixed: the API rejected requests with
 *   400 "messages.565.content.0.thinking: each thinking block must contain
 *   thinking"
 * because a `thinking` block (sometimes an EMPTY one from a partial stream,
 * sometimes from an imported Claude Code session recorded with extended
 * thinking) ended up in the OUTBOUND history. We don't send the `thinking`
 * request param, so any thinking block is invalid to re-send.
 *
 * Two layers of defense, both tested here:
 *   1. `stripThinkingBlocks(content)` — applied at the live persist+push
 *      site so neither the JSONL nor the in-memory array carries one.
 *   2. `sanitizeMessages` Pass -1 — a backstop on every outbound path
 *      (covers seeded history + recovery + anything that slips past #1).
 */
import { describe, expect, it } from 'vitest';
import {
  sanitizeMessages,
  stripThinkingBlocks,
} from '../electron/sessionRuntime';

describe('stripThinkingBlocks', () => {
  it('removes thinking blocks from an assistant content array', () => {
    const content = [
      { type: 'thinking', thinking: 'let me reason...', signature: 'abc' },
      { type: 'text', text: 'Here is the answer.' },
    ];
    expect(stripThinkingBlocks(content)).toEqual([
      { type: 'text', text: 'Here is the answer.' },
    ]);
  });

  it('removes an EMPTY thinking block (the exact 400 trigger)', () => {
    const content = [
      { type: 'thinking', thinking: '' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    ];
    expect(stripThinkingBlocks(content)).toEqual([
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
    ]);
  });

  it('removes redacted_thinking blocks too', () => {
    const content = [
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'ok' },
    ];
    expect(stripThinkingBlocks(content)).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('passes a plain string through unchanged', () => {
    expect(stripThinkingBlocks('hello')).toBe('hello');
  });

  it('returns an empty array when every block was a thinking block', () => {
    const content = [{ type: 'thinking', thinking: 'only thinking' }];
    expect(stripThinkingBlocks(content)).toEqual([]);
  });

  it('leaves content with no thinking blocks untouched', () => {
    const content = [{ type: 'text', text: 'a' }];
    expect(stripThinkingBlocks(content)).toEqual([{ type: 'text', text: 'a' }]);
  });
});

describe('sanitizeMessages — Pass -1 (thinking strip)', () => {
  it('strips a thinking block at content index 0 of an assistant message', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' } as any,
          { type: 'text', text: 'hello back' },
        ],
      },
      { role: 'user', content: 'continue' },
    ]);
    // The assistant message survives with only its text block.
    const assistant = out.find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant!.content).toEqual([{ type: 'text', text: 'hello back' }]);
    // No thinking block survives anywhere.
    for (const m of out) {
      if (Array.isArray(m.content)) {
        for (const b of m.content as any[]) {
          expect(b.type).not.toBe('thinking');
          expect(b.type).not.toBe('redacted_thinking');
        }
      }
    }
  });

  it('drops an assistant message whose ONLY block was thinking, fixing alternation', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' } as any] },
      { role: 'user', content: 'second' },
    ]);
    // The thinking-only assistant is dropped; the two user messages would
    // then be adjacent, so pass 3 merges them into one.
    expect(out.every((m) => m.role !== 'assistant' || (Array.isArray(m.content) && (m.content as any[]).length > 0))).toBe(true);
    // No assistant message remains (it was thinking-only).
    const assistants = out.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(0);
  });

  it('preserves a normal tool_use / tool_result exchange while stripping thinking', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'planning' } as any,
          { type: 'text', text: 'running tool' },
          { type: 'tool_use', id: 'tu1', name: 'Read', input: { p: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file body' }],
      },
    ]);
    const assistant = out.find((m) => m.role === 'assistant')!;
    const blocks = assistant.content as any[];
    expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && b.text === 'running tool')).toBe(true);
    expect(blocks.some((b) => b.type === 'tool_use' && b.id === 'tu1')).toBe(true);
    // The tool_result is preserved (pairing intact).
    const userResult = out.find(
      (m) => Array.isArray(m.content) && (m.content as any[]).some((b) => b.type === 'tool_result')
    );
    expect(userResult).toBeTruthy();
  });

  it('is idempotent (running twice yields the same result)', () => {
    const input = [
      { role: 'user' as const, content: 'q' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'thinking', thinking: 't' } as any,
          { type: 'text', text: 'a' },
        ],
      },
      { role: 'user' as const, content: 'go' },
    ];
    const once = sanitizeMessages(input);
    const twice = sanitizeMessages(once);
    expect(twice).toEqual(once);
  });
});

describe('sanitizeMessages: interrupted WaitFor* tool (restart resume safety)', () => {
  it('synthesizes a tool_result for a trailing WaitForFile tool_use with no result', () => {
    // This is the exact shape when the app dies mid-WaitForFile and we
    // resume the turn with continueExisting: the last assistant message has
    // a tool_use (WaitForFile) but the JSONL has no matching tool_result
    // because the poll never returned. Without repair, re-sending this 400s.
    const out = sanitizeMessages([
      { role: 'user', content: 'watch for the build output' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Watching the file.' },
          { type: 'tool_use', id: 'wf1', name: 'WaitForFile', input: { file_path: '/tmp/done' } },
        ] as any,
      },
    ]);
    // A trailing user message with a synthetic tool_result for wf1 must exist
    // so the API contract (every tool_use has a matching tool_result) holds.
    const last = out[out.length - 1];
    expect(last.role).toBe('user');
    const results = (last.content as any[]).filter((b) => b.type === 'tool_result');
    expect(results.some((r) => r.tool_use_id === 'wf1')).toBe(true);
    // The assistant tool_use survives (we resume from it, not drop it).
    const asst = out.find((m) => m.role === 'assistant')!;
    expect((asst.content as any[]).some((b) => b.type === 'tool_use' && b.id === 'wf1')).toBe(true);
  });
});
