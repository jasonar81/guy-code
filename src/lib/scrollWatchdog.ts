/**
 * Decision rule for the MessageList scroll-up watchdog.
 *
 * The watchdog (in `@/components/MessageList.tsx`) listens for scroll
 * events on Virtuoso's underlying scroller and decides whether each
 * transition is "real" (user gesture, allowed) or "spurious" (some
 * combination of parent layout shifts, fast text_delta storms, or
 * above-viewport item re-measurements that yank the user upward
 * unintentionally).
 *
 * This rule is a pure function so it can be unit-tested without a
 * DOM. The actual side effect (calling `el.scrollTo({top: prev})`)
 * lives in MessageList; this just decides go/no-go.
 *
 * Rule history:
 *
 *   v1 (kept-too-narrow): Fired only when newScrollTop === 0 AND
 *      prev > 200. This missed the case where Virtuoso landed the
 *      spurious scroll on a NON-zero value (e.g. 50, 200), and it
 *      missed multi-event spurious scrolls where the position
 *      arrived at 0 over several events — by the final event,
 *      `lastScrollTopRef` had been overwritten by intermediate
 *      values, so even when v1 fired its restore target was wrong.
 *
 *   v2: Fires on ANY large upward jump (>150px) without a recent
 *      user gesture. The first event of a multi-event spurious
 *      scroll is always large enough to catch — so we restore to
 *      the still-correct prev BEFORE the intermediate poisoning
 *      happens. Threshold 150px skips legitimate layout-clamp
 *      scrolls (composer textarea grow/shrink, plan panel expand/
 *      collapse) while catching the actual bug, which empirically
 *      is always >500px per event.
 *
 *   v3: Adds a second, ORTHOGONAL line of defense — a
 *      cumulative-drift rule. v2 misses the slow-drift case where
 *      streaming-induced re-measurements yank the viewport up by
 *      <150px PER EVENT but accumulate to a multi-hundred-px total
 *      drift over many events. v3 tracks a "no-gesture baseline"
 *      (the scrollTop captured at the last user gesture; resets
 *      every time a gesture lands). If `baseline - cur > 400`
 *      AND no recent gesture, restore to baseline. 400px is large
 *      enough that legitimate clamp drifts (composer growing 5
 *      lines, plan panel expanding) don't trip it; it requires a
 *      sustained pattern of upward yanks, which is exactly the
 *      bug we want to catch.
 *
 *   v4 (this file): Adds a post-mount window. Right after a
 *      Virtuoso remount (visKey bump on session-pane visibility
 *      flip), the scroller is fresh — `lastScrollTopRef` and
 *      `noGestureBaselineRef` carry no signal yet, and Virtuoso
 *      itself may briefly land at scrollTop=0 before its
 *      `initialTopMostItemIndex` directive runs. v3's "items > 10"
 *      floor disabled the watchdog for that initial transient
 *      regardless of list size, leaving the user occasionally
 *      stranded at the top of a long conversation. v4 drops the
 *      items floor for the first 500 ms after mount: any
 *      transition from a non-zero prev to scrollTop=0 in that
 *      window is treated as the bug, regardless of list length.
 *      Caller passes `msSincePostMount` (time since the scroller
 *      element was last captured by the ref callback). After 500 ms
 *      v3 semantics resume.
 */

/**
 * Within this window of the last user gesture (wheel/touch/keydown/
 * mousedown), we always honor the scroll change — the user wanted it.
 */
const USER_GESTURE_GRACE_MS = 200;

/**
 * Lists shorter than this don't get watchdog protection. A short list
 * has no "above the viewport" content for Virtuoso to re-measure, and
 * the scroll-to-top failure mode requires above-viewport churn to
 * trigger. Below this size, large scroll jumps are usually intended.
 */
const ITEMS_THRESHOLD = 10;

/**
 * Minimum upward jump (in px) to flag as spurious. The actual bug we
 * chase produces jumps of hundreds-to-thousands of px (often the
 * entire scroll height), so a conservative 150px threshold gives
 * massive headroom while still skipping legitimate layout-clamp
 * scrolls — empirically <100px when the composer textarea grows or
 * shrinks by a line or two.
 */
const BIG_UPWARD_JUMP_PX = 150;

/**
 * Cumulative-drift threshold (in px). When the scroll position has
 * drifted upward by more than this much TOTAL since the last user
 * gesture, the watchdog restores to the gesture baseline. 400 px is
 * roughly two screenfuls of conversation height — well past any
 * legitimate auto-clamp drift from composer growth or plan-panel
 * expansion (those are at most ~200 px combined), but tight enough
 * to catch the bug before the user has to refind their place.
 */
const CUMULATIVE_DRIFT_PX = 400;

/**
 * Post-mount window (ms). Within this much time of the scroller
 * element being captured by the ref callback, the watchdog drops
 * the `itemsLength > ITEMS_THRESHOLD` floor — any transition from
 * a non-zero prev to scrollTop=0 in this window is treated as
 * Virtuoso landing in a transient bad state, regardless of list
 * size. After this window expires, the normal v3 rules apply.
 */
const POST_MOUNT_WINDOW_MS = 500;

/**
 * Minimum prev scrollTop required to fire the post-mount rule.
 * If the scroller already had little or no scroll position before
 * the suspicious event, snapping back to 0 isn't the bug — it
 * might just be the natural resting state of a freshly-mounted
 * short list. Requiring a meaningful drop guards against false
 * positives on tiny conversations.
 */
const POST_MOUNT_MIN_PREV_PX = 100;

export interface ScrollWatchdogInput {
  /** Last observed scrollTop before this event. */
  prevScrollTop: number;
  /** scrollTop reported by the current event. */
  newScrollTop: number;
  /** Milliseconds since the last user-driven gesture. */
  msSinceUserGesture: number;
  /** Number of items in the virtualized list at this moment. */
  itemsLength: number;
  /**
   * scrollTop captured at the last user gesture (wheel / touch /
   * keydown / scrollbar-drag). The cumulative-drift rule compares
   * the CURRENT scrollTop against this baseline. Pass the same
   * value as `prevScrollTop` if no gesture has been recorded yet —
   * the rule will treat that as "no drift to detect" because the
   * msSinceUserGesture filter rejects fresh-mount events anyway.
   */
  noGestureBaseline: number;
  /**
   * Optional: milliseconds since the scroller DOM element was last
   * captured by the ref callback (i.e., since the most recent
   * Virtuoso mount). When provided AND <= POST_MOUNT_WINDOW_MS,
   * the watchdog drops the items-length floor and fires on any
   * non-zero → 0 transition. Omit (or pass `undefined`) to disable
   * the post-mount rule and use v3 semantics only — back-compat
   * for tests / callers that don't track mount time.
   */
  msSincePostMount?: number;
}

/** Outcome of the watchdog rule. The caller restores to `restoreTo`. */
export interface ScrollWatchdogDecision {
  /** Whether the scroll event is spurious and should be undone. */
  spurious: boolean;
  /**
   * Target scrollTop the caller should pass to `el.scrollTo({top})`
   * when `spurious === true`. Either the immediate `prevScrollTop`
   * (per-event rule) or the gesture baseline (cumulative-drift
   * rule), depending on which condition fired. Undefined when
   * `spurious === false`.
   */
  restoreTo?: number;
  /**
   * Which rule fired. Surfaced for debugging (the MessageList
   * watchdog logs this when scrollDebug=1 is set).
   */
  reason?: 'big-jump' | 'cumulative-drift' | 'post-mount-zero';
}

/**
 * Returns the watchdog decision for one scroll event.
 *
 * Three orthogonal rules; first match wins (checked in order):
 *
 *   • post-mount-zero: within POST_MOUNT_WINDOW_MS of a fresh
 *                      scroller mount, prev > POST_MOUNT_MIN_PREV_PX
 *                      and new === 0. Restore target: prevScrollTop.
 *                      Applies even on short lists — this rule
 *                      catches Virtuoso landing badly right after
 *                      a remount before its initialTopMostItemIndex
 *                      directive runs.
 *   • big-jump:        per-event upward jump > BIG_UPWARD_JUMP_PX.
 *                      Restore target: prevScrollTop.
 *   • cumulative-drift: total drift from the gesture baseline
 *                      > CUMULATIVE_DRIFT_PX. Restore target:
 *                      noGestureBaseline.
 *
 * big-jump and cumulative-drift require:
 *   • itemsLength > ITEMS_THRESHOLD (short lists don't get
 *     watchdog protection).
 *
 * All three rules require:
 *   • msSinceUserGesture > USER_GESTURE_GRACE_MS (within the grace
 *     window, the user is the one driving the scroll).
 *
 * Downward scrolls are never flagged: the streaming-keep-up effect
 * calls `scrollToIndex({align:'end'})` which is the only
 * programmatic source of downward jumps and is always what the
 * user wants when they're following a stream.
 */
export function decideScrollWatchdog(
  args: ScrollWatchdogInput
): ScrollWatchdogDecision {
  if (args.msSinceUserGesture <= USER_GESTURE_GRACE_MS) return { spurious: false };
  // Post-mount rule fires FIRST and bypasses the items-length
  // floor — within the post-mount window, the scroller is too
  // fresh to trust list-length signals. We only check it when the
  // caller actually provided msSincePostMount (back-compat: omit
  // to skip).
  if (
    args.msSincePostMount !== undefined &&
    args.msSincePostMount <= POST_MOUNT_WINDOW_MS &&
    args.prevScrollTop > POST_MOUNT_MIN_PREV_PX &&
    args.newScrollTop === 0
  ) {
    return {
      spurious: true,
      restoreTo: args.prevScrollTop,
      reason: 'post-mount-zero',
    };
  }
  if (args.itemsLength <= ITEMS_THRESHOLD) return { spurious: false };
  const upwardJump = args.prevScrollTop - args.newScrollTop;
  if (upwardJump > BIG_UPWARD_JUMP_PX) {
    return {
      spurious: true,
      restoreTo: args.prevScrollTop,
      reason: 'big-jump',
    };
  }
  const cumulativeDrift = args.noGestureBaseline - args.newScrollTop;
  if (cumulativeDrift > CUMULATIVE_DRIFT_PX) {
    return {
      spurious: true,
      restoreTo: args.noGestureBaseline,
      reason: 'cumulative-drift',
    };
  }
  return { spurious: false };
}

/**
 * Back-compat wrapper. Older tests / call sites only need a boolean
 * answer ("is this spurious?"); they don't care which rule fired or
 * what the restore target is. New code should call
 * `decideScrollWatchdog` directly so it can use the cumulative-drift
 * restore target when that's the reason.
 *
 * Implementation: synthesizes a `noGestureBaseline === prevScrollTop`
 * input, which makes the cumulative rule equivalent to the big-jump
 * rule. So the returned boolean matches v2 semantics exactly when
 * the caller doesn't track a baseline.
 */
export function isSpuriousScrollToTop(
  args: Omit<ScrollWatchdogInput, 'noGestureBaseline'>
): boolean {
  return decideScrollWatchdog({
    ...args,
    noGestureBaseline: args.prevScrollTop,
  }).spurious;
}
