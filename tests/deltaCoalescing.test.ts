/**
 * Streaming text deltas are coalesced into one store update per animation
 * frame (App.tsx). The model emits one IPC message PER TOKEN, and each used to
 * drive a full store update + re-render, which locked up typing/scrolling while
 * the open session streamed.
 *
 * The coalescing must be lossless: same text, same order, and any non-delta
 * event must land AFTER the text buffered before it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/** Reimplementation of the buffering in App.tsx, exercised directly. */
function makeCoalescer(apply: (e: any) => void) {
  const pending = new Map<string, string>();
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (pending.size === 0) return;
    for (const [sessionId, text] of pending) {
      apply({ type: 'text_delta', sessionId, text });
    }
    pending.clear();
  };
  const scheduleFlush = () => {
    if (!raf) raf = requestAnimationFrame(flush);
  };
  return {
    onEvent(e: any) {
      if (e?.type === 'text_delta' && typeof e.text === 'string' && e.sessionId) {
        pending.set(e.sessionId, (pending.get(e.sessionId) ?? '') + e.text);
        scheduleFlush();
        return;
      }
      if (pending.size) flush();
      apply(e);
    },
    flushNow: flush,
  };
}

let rafCbs: FrameRequestCallback[] = [];
beforeEach(() => {
  rafCbs = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCbs.push(cb);
    return rafCbs.length;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const runFrame = () => {
  const cbs = rafCbs;
  rafCbs = [];
  for (const cb of cbs) cb(0);
};

describe('text_delta coalescing', () => {
  it('combines many token deltas into ONE store update per frame', () => {
    const applied: any[] = [];
    const c = makeCoalescer((e) => applied.push(e));
    for (const t of ['Hel', 'lo ', 'wor', 'ld']) {
      c.onEvent({ type: 'text_delta', sessionId: 's1', text: t });
    }
    expect(applied).toHaveLength(0); // nothing applied yet - still buffered
    runFrame();
    expect(applied).toHaveLength(1);
    expect(applied[0]).toEqual({ type: 'text_delta', sessionId: 's1', text: 'Hello world' });
  });

  it('loses no text across multiple frames', () => {
    const applied: any[] = [];
    const c = makeCoalescer((e) => applied.push(e));
    c.onEvent({ type: 'text_delta', sessionId: 's1', text: 'aaa' });
    runFrame();
    c.onEvent({ type: 'text_delta', sessionId: 's1', text: 'bbb' });
    runFrame();
    expect(applied.map((e) => e.text).join('')).toBe('aaabbb');
  });

  it('keeps sessions separate', () => {
    const applied: any[] = [];
    const c = makeCoalescer((e) => applied.push(e));
    c.onEvent({ type: 'text_delta', sessionId: 's1', text: 'one' });
    c.onEvent({ type: 'text_delta', sessionId: 's2', text: 'two' });
    runFrame();
    expect(applied).toHaveLength(2);
    expect(applied.find((e) => e.sessionId === 's1').text).toBe('one');
    expect(applied.find((e) => e.sessionId === 's2').text).toBe('two');
  });

  it('flushes buffered text BEFORE a non-delta event (ordering preserved)', () => {
    const applied: any[] = [];
    const c = makeCoalescer((e) => applied.push(e));
    c.onEvent({ type: 'text_delta', sessionId: 's1', text: 'partial' });
    c.onEvent({ type: 'turn_done', sessionId: 's1' });
    // No frame needed - the non-delta event forced the flush.
    expect(applied).toHaveLength(2);
    expect(applied[0].type).toBe('text_delta');
    expect(applied[0].text).toBe('partial');
    expect(applied[1].type).toBe('turn_done');
  });

  it('passes non-delta events straight through', () => {
    const applied: any[] = [];
    const c = makeCoalescer((e) => applied.push(e));
    c.onEvent({ type: 'state_changed', sessionId: 's1', state: 'running' });
    expect(applied).toHaveLength(1);
    expect(applied[0].type).toBe('state_changed');
  });

  it('schedules only ONE frame no matter how many tokens arrive', () => {
    const c = makeCoalescer(() => {});
    for (let i = 0; i < 500; i++) {
      c.onEvent({ type: 'text_delta', sessionId: 's1', text: 'x' });
    }
    expect(rafCbs).toHaveLength(1);
  });
});
