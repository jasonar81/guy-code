/**
 * Tests for `electron/transientRetry.ts` — the pure decision + interruptible
 * sleep behind the agent's transient-error retry loop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideTransientRetry,
  sleepUnlessAborted,
  DEFAULT_TRANSIENT_RETRY_INTERVAL_MS,
  DEFAULT_TRANSIENT_RETRY_MAX_ATTEMPTS,
} from '../electron/transientRetry';

describe('decideTransientRetry', () => {
  const isTransient = () => true;
  const notTransient = () => false;

  it('retries a transient error while under the attempt ceiling', () => {
    const d = decideTransientRetry({
      err: { status: 529 },
      attempt: 1,
      maxAttempts: 15,
      intervalMs: 60_000,
      isTransient,
    });
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(60_000);
  });

  it('stops retrying once the attempt count reaches maxAttempts', () => {
    const d = decideTransientRetry({
      err: { status: 529 },
      attempt: 15,
      maxAttempts: 15,
      intervalMs: 60_000,
      isTransient,
    });
    expect(d.retry).toBe(false);
    expect(d.delayMs).toBe(0);
  });

  it('does not retry a non-transient error even on the first attempt', () => {
    const d = decideTransientRetry({
      err: { status: 400 },
      attempt: 1,
      maxAttempts: 15,
      intervalMs: 60_000,
      isTransient: notTransient,
    });
    expect(d.retry).toBe(false);
    expect(d.delayMs).toBe(0);
  });

  it('clamps a negative interval to 0', () => {
    const d = decideTransientRetry({
      err: {},
      attempt: 1,
      maxAttempts: 5,
      intervalMs: -100,
      isTransient,
    });
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(0);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_TRANSIENT_RETRY_INTERVAL_MS).toBe(60_000);
    expect(DEFAULT_TRANSIENT_RETRY_MAX_ATTEMPTS).toBe(15);
  });
});

describe('sleepUnlessAborted', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves "slept" after the full duration when not aborted', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = sleepUnlessAborted(60_000, ac.signal);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toBe('slept');
  });

  it('resolves "aborted" immediately if the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepUnlessAborted(60_000, ac.signal)).resolves.toBe('aborted');
  });

  it('resolves "aborted" when the signal fires mid-wait', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = sleepUnlessAborted(60_000, ac.signal);
    // Advance partway, then abort before the timer would fire.
    await vi.advanceTimersByTimeAsync(10_000);
    ac.abort();
    await expect(p).resolves.toBe('aborted');
  });

  it('does not resolve before either the timer or an abort', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    let settled = false;
    const p = sleepUnlessAborted(60_000, ac.signal).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(settled).toBe(true);
  });
});
