/**
 * Regression tests for the Anthropic cache_control breakpoint count.
 *
 * Anthropic's API rejects requests with more than 4 `cache_control`
 * blocks (error: "A maximum of 4 blocks with cache_control may be
 * provided. Found N."). This is easy to break silently because each
 * block adds its own `cache_control` and tests rarely compose all the
 * conditional ones at once.
 *
 * The matrix we cover here:
 *   • System blocks: intro (always), env (always, no breakpoint), memory
 *     (optional+breakpoint), skills (optional+breakpoint), activePlan
 *     (optional, no breakpoint), currentTask (optional, no breakpoint).
 *   • Conversation breakpoint: 1, attached by `withConversationCacheBreakpoint`.
 *
 * Worst case = all optional blocks present = 3 system breakpoints + 1
 * conversation breakpoint = 4. Anything above 4 = production-breaking.
 *
 * This test exists because the bug DID land in production: when we added
 * the skills block as a 4th cached system slot, the env block still had
 * its own `cache_control`, pushing the total to 5 and triggering the
 * 400 error. The fix was to drop env's breakpoint; this test pins that.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSystemBlocks,
  withConversationCacheBreakpoint,
} from '../electron/anthropic';

const FIXED_DATE = new Date('2026-05-23T19:00:00Z');

function countBreakpoints(blocks: ReadonlyArray<{ cache_control?: unknown }>): number {
  return blocks.filter((b) => b.cache_control != null).length;
}

describe('cache_control breakpoint budget', () => {
  it('intro-only (no memory, no skills) → 1 system breakpoint', () => {
    const sys = buildSystemBlocks({
      sessionId: 's1',
      cwd: '/home/x',
      date: FIXED_DATE,
      platform: 'linux',
    });
    expect(countBreakpoints(sys)).toBe(1);
  });

  it('intro + memory → 2 system breakpoints', () => {
    const sys = buildSystemBlocks({
      sessionId: 's1',
      cwd: '/home/x',
      date: FIXED_DATE,
      platform: 'linux',
      memoryText: '# Project notes\nSome stuff',
    });
    expect(countBreakpoints(sys)).toBe(2);
  });

  it('intro + skills (no memory) → 2 system breakpoints', () => {
    const sys = buildSystemBlocks({
      sessionId: 's1',
      cwd: '/home/x',
      date: FIXED_DATE,
      platform: 'linux',
      skillsBlock: 'Available skills:\n- foo\n- bar',
    });
    expect(countBreakpoints(sys)).toBe(2);
  });

  it('intro + memory + skills → 3 system breakpoints (max)', () => {
    const sys = buildSystemBlocks({
      sessionId: 's1',
      cwd: '/home/x',
      date: FIXED_DATE,
      platform: 'linux',
      memoryText: '# Project notes\nSome stuff',
      skillsBlock: 'Available skills:\n- foo\n- bar',
    });
    expect(countBreakpoints(sys)).toBe(3);
  });

  it('activePlan and currentTask add NO breakpoints (un-cached by design)', () => {
    const sys = buildSystemBlocks({
      sessionId: 's1',
      cwd: '/home/x',
      date: FIXED_DATE,
      platform: 'linux',
      memoryText: 'memory',
      skillsBlock: 'skills',
      activePlanBlock: '## Active Plan\n1. step',
      currentTask: 'do the thing',
    });
    // Still 3 — activePlan and currentTask are intentionally un-cached so
    // they can mutate freely without invalidating the cached prefix.
    expect(countBreakpoints(sys)).toBe(3);
  });

  it('env block has NO breakpoint — caching the 30-token env slot is not worth a slot', () => {
    const sys = buildSystemBlocks({
      sessionId: 's1',
      cwd: '/home/x',
      date: FIXED_DATE,
      platform: 'linux',
    });
    // The env block is identifiable by its "Environment:" prefix; assert
    // it exists and explicitly has no cache_control.
    const env = sys.find(
      (b) => typeof (b as any).text === 'string' && (b as any).text.startsWith('Environment:')
    );
    expect(env).toBeDefined();
    expect((env as any).cache_control).toBeUndefined();
  });

  it('REGRESSION — full system + conversation breakpoint stays ≤ 4', () => {
    // This is the exact scenario that triggered the production 400. A
    // session with both memory loaded AND skills loaded AND a final user
    // message that gets a conversation breakpoint = 5 breakpoints under
    // the bug. Pin to ≤ 4 forever.
    const sys = buildSystemBlocks({
      sessionId: 's1',
      cwd: '/home/x',
      date: FIXED_DATE,
      platform: 'linux',
      memoryText: 'memory present',
      skillsBlock: 'skills present',
      activePlanBlock: 'plan present',
      currentTask: 'task present',
    });
    const messages = withConversationCacheBreakpoint([
      { role: 'user', content: 'hello' },
    ]);
    const lastMsg = messages[messages.length - 1] as { content: any[] };
    const convoBreakpoints = countBreakpoints(lastMsg.content);
    const systemBreakpoints = countBreakpoints(sys);
    expect(systemBreakpoints + convoBreakpoints).toBeLessThanOrEqual(4);
  });
});
