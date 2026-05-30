/**
 * Helpers for the agent's transient-error retry loop.
 *
 * Motivation: transient upstream failures (Anthropic 529 "overloaded", 5xx,
 * 429, connection blips) used to surface to the user immediately, aborting
 * the turn over what is almost always a few-minutes-long hiccup. Instead we
 * want to retry on a ~once-a-minute cadence and only surface the error after
 * a long run of consecutive failures (~15 over ~15 minutes by default).
 *
 * This module holds the two pieces that are worth isolating + unit-testing:
 *   • `decideTransientRetry` — the pure decision: given an error, the
 *     current consecutive-failure count, and the classifier, should we
 *     retry, and after how long?
 *   • `sleepUnlessAborted` — an interruptible sleep so a user-initiated
 *     cancel during the wait stops the retry immediately rather than
 *     blocking for the full interval.
 *
 * The agent owns the loop + event emission; these helpers keep the
 * testable logic out of the giant turn function.
 */

export interface TransientRetryDecision {
  /** Whether to wait and retry the same API call. */
  retry: boolean;
  /** How long to wait before the retry, in ms (0 when not retrying). */
  delayMs: number;
}

export interface DecideTransientRetryArgs {
  /** The error thrown by the API call. */
  err: unknown;
  /**
   * How many consecutive transient failures have already occurred,
   * INCLUDING this one. (i.e. the caller increments before calling, or
   * passes the post-increment value.) First failure → 1.
   */
  attempt: number;
  /** Surface the error once this many consecutive failures is reached. */
  maxAttempts: number;
  /** Fixed wait between retries, in ms. */
  intervalMs: number;
  /** Predicate deciding whether `err` is the kind we retry transparently. */
  isTransient: (e: unknown) => boolean;
}

/**
 * Decide whether to retry a failed API call.
 *
 * retry = the error is transient AND we have NOT yet hit the consecutive
 * failure ceiling. When we've hit the ceiling, retry is false so the caller
 * surfaces the (classified) error to the user. Non-transient errors never
 * retry — they need user action, so silently waiting would just hang.
 */
export function decideTransientRetry(args: DecideTransientRetryArgs): TransientRetryDecision {
  const { err, attempt, maxAttempts, intervalMs, isTransient } = args;
  if (!isTransient(err)) return { retry: false, delayMs: 0 };
  if (attempt >= maxAttempts) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: Math.max(0, intervalMs) };
}

/**
 * Sleep for `ms`, but resolve early if `signal` aborts. Returns `'slept'`
 * if the full duration elapsed, `'aborted'` if the signal fired first (or
 * was already aborted on entry). Never rejects.
 *
 * Used so a user cancel during the inter-retry wait takes effect
 * immediately instead of blocking for up to a minute.
 */
export function sleepUnlessAborted(
  ms: number,
  signal: AbortSignal
): Promise<'slept' | 'aborted'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      resolve('aborted');
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve('slept');
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Default retry cadence: one attempt per minute. */
export const DEFAULT_TRANSIENT_RETRY_INTERVAL_MS = 60_000;
/** Default ceiling: ~15 consecutive failures (~15 minutes) before surfacing. */
export const DEFAULT_TRANSIENT_RETRY_MAX_ATTEMPTS = 15;
