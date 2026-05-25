/**
 * Tests for `src/lib/scrollWatchdog.ts`.
 *
 * The watchdog defends against mid-session upward-yank scrolls caused
 * by Virtuoso re-measurements (Composer growth, CurrentPlanPanel
 * appearance, fast text_delta storms). These tests pin down when the
 * decision rule fires vs. honors the scroll change.
 *
 * The v2 rule (this version) treats ANY large upward jump (>150px)
 * without a recent user gesture as spurious — not just jumps that
 * land at exactly 0. The previous v1 rule missed the multi-event
 * spurious-scroll case (Virtuoso ramps from 5000 → 0 over 5 events,
 * each below the v1 threshold individually) and missed Virtuoso's
 * occasional "land at 50 instead of 0" variant of the same bug.
 */
import { describe, expect, it } from 'vitest';
import {
  decideScrollWatchdog,
  isSpuriousScrollToTop,
} from '../src/lib/scrollWatchdog';

/**
 * Canonical "this scroll is spurious" input: user was 1000px down, the
 * conversation is long, no user gesture in seconds, a sudden jump up.
 */
const baseInput = {
  prevScrollTop: 1000,
  newScrollTop: 0,
  msSinceUserGesture: 5000,
  itemsLength: 100,
};

describe('isSpuriousScrollToTop', () => {
  it('fires for the canonical bug: big mid-list upward jump with no gesture', () => {
    expect(isSpuriousScrollToTop(baseInput)).toBe(true);
  });

  it('fires when Virtuoso lands the scroll at a NON-zero value (not just 0)', () => {
    // The v1 rule missed this — Virtuoso sometimes lands the spurious
    // scroll at 50 or 200 instead of exactly 0. v2 catches because
    // the JUMP size is what matters, not the final position.
    expect(
      isSpuriousScrollToTop({ ...baseInput, newScrollTop: 50 })
    ).toBe(true);
    expect(
      isSpuriousScrollToTop({ ...baseInput, newScrollTop: 200 })
    ).toBe(true);
  });

  it('fires for a partial mid-stream jump (5000 → 4500) — first event of a multi-event spurious scroll', () => {
    // The v1 rule missed this entire class because each individual
    // event was small enough to look legitimate; only the FINAL
    // event landing at 0 triggered v1, but by then lastScrollTopRef
    // had already been overwritten by the intermediate values, so
    // the restore went to 200 (or wherever) instead of 5000.
    // v2 catches the FIRST event and restores from the still-correct
    // 5000 prev value.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 5000,
        newScrollTop: 4500,
        msSinceUserGesture: 5000,
        itemsLength: 200,
      })
    ).toBe(true);
  });

  it('does NOT fire on small upward jumps (composer textarea grow/shrink, plan panel toggle)', () => {
    // Layout-clamp scrolls are typically <100px — the composer
    // growing by a line, the plan panel collapsing, etc. We don't
    // want to fight those: they're physically caused by viewport
    // changes, not by a Virtuoso re-measurement bug.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 5000,
        newScrollTop: 4920, // 80px jump up — within layout-clamp range
        msSinceUserGesture: 5000,
        itemsLength: 200,
      })
    ).toBe(false);
    // Boundary: exactly 150px doesn't fire (rule is strictly >150).
    expect(
      isSpuriousScrollToTop({
        ...baseInput,
        prevScrollTop: 1150,
        newScrollTop: 1000,
      })
    ).toBe(false);
    // 151px up fires.
    expect(
      isSpuriousScrollToTop({
        ...baseInput,
        prevScrollTop: 1151,
        newScrollTop: 1000,
      })
    ).toBe(true);
  });

  it('does NOT fire on downward scrolls (streaming follow, jump-to-bottom)', () => {
    // The streaming-keep-up effect calls scrollToIndex({align:'end'})
    // which moves scrollTop downward. Watchdog must never flag those.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 4000,
        newScrollTop: 8000, // scrolled DOWN by 4000px
        msSinceUserGesture: 5000,
        itemsLength: 200,
      })
    ).toBe(false);
  });

  it('does NOT fire when a user gesture occurred recently', () => {
    // The user wheeled / pressed PageUp / dragged the scrollbar.
    // We respect their intent regardless of jump size.
    expect(
      isSpuriousScrollToTop({ ...baseInput, msSinceUserGesture: 50 })
    ).toBe(false);
    // Boundary: exactly 200ms doesn't fire (rule is strictly >200).
    expect(
      isSpuriousScrollToTop({ ...baseInput, msSinceUserGesture: 200 })
    ).toBe(false);
    // Just above the boundary fires.
    expect(
      isSpuriousScrollToTop({ ...baseInput, msSinceUserGesture: 201 })
    ).toBe(true);
  });

  it('does NOT fire on small lists where measurement churn is harmless', () => {
    // Below the items threshold, scroll resets are usually intended
    // (empty conversation, single message, just-loaded session).
    for (const len of [0, 1, 5, 10]) {
      expect(
        isSpuriousScrollToTop({ ...baseInput, itemsLength: len }),
        `len=${len}`
      ).toBe(false);
    }
    // Just above threshold (rule is strictly >10) fires.
    expect(
      isSpuriousScrollToTop({ ...baseInput, itemsLength: 11 })
    ).toBe(true);
  });

  it('handles the realistic streaming-with-no-user-input scenario', () => {
    // A long-running turn is streaming; Composer grew because the
    // user typed a queued reply. Virtuoso re-measures, scrollTop
    // suddenly drops 8000px upward. User hasn't touched anything in 30s.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 8500,
        newScrollTop: 500,
        msSinceUserGesture: 30_000,
        itemsLength: 250,
      })
    ).toBe(true);
  });

  it('honors a scrollbar drag-to-top (user gesture within grace)', () => {
    // The user grabbed the scrollbar thumb and yanked it to the top.
    // mousedown fires, then a flurry of scroll events, the last of
    // which lands at 0. msSinceUserGesture is small.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 8500,
        newScrollTop: 0,
        msSinceUserGesture: 80,
        itemsLength: 250,
      })
    ).toBe(false);
  });

  it('handles the all-conditions-failing and all-conditions-passing boundaries', () => {
    // All three conditions failing (small list, recent gesture, small jump) → false.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 100,
        newScrollTop: 50,
        msSinceUserGesture: 50,
        itemsLength: 5,
      })
    ).toBe(false);
    // All three conditions passing → true.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 1000,
        newScrollTop: 0,
        msSinceUserGesture: 1000,
        itemsLength: 100,
      })
    ).toBe(true);
  });
});

describe('decideScrollWatchdog — cumulative drift (v3)', () => {
  // Slow-drift scenario: user gestured at scrollTop=5000, then over
  // many small spurious events each <150px, scrollTop drifts down to
  // 4400 (a 600px cumulative yank from where they were reading). The
  // per-event rule alone wouldn't catch any of those individually.
  // The cumulative rule restores them to 5000.
  it('fires on cumulative drift past threshold (v2 alone would miss this)', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 4500,
      newScrollTop: 4400,
      msSinceUserGesture: 5000,
      itemsLength: 100,
      noGestureBaseline: 5000, // user gestured here long ago
    });
    expect(decision.spurious).toBe(true);
    expect(decision.reason).toBe('cumulative-drift');
    expect(decision.restoreTo).toBe(5000);
  });

  it('does NOT fire if total drift is within threshold', () => {
    // 5000 → 4700 is a 300px drift, under the 400px cumulative
    // threshold. Probably a legitimate composer/plan-panel clamp.
    const decision = decideScrollWatchdog({
      prevScrollTop: 4750,
      newScrollTop: 4700,
      msSinceUserGesture: 5000,
      itemsLength: 100,
      noGestureBaseline: 5000,
    });
    expect(decision.spurious).toBe(false);
  });

  it('boundary: exactly 400px cumulative drift does NOT fire (rule is >400)', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 4650,
      newScrollTop: 4600,
      msSinceUserGesture: 5000,
      itemsLength: 100,
      noGestureBaseline: 5000,
    });
    expect(decision.spurious).toBe(false);
  });

  it('boundary: 401px cumulative drift fires', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 4650,
      newScrollTop: 4599,
      msSinceUserGesture: 5000,
      itemsLength: 100,
      noGestureBaseline: 5000,
    });
    expect(decision.spurious).toBe(true);
    expect(decision.reason).toBe('cumulative-drift');
  });

  it('per-event rule wins over cumulative when both apply (cleaner restore target)', () => {
    // A 1000px single-event jump that ALSO crosses the 400px
    // cumulative line. The per-event rule is preferred because its
    // restore target (prev) is closer to where the user was JUST
    // looking than the gesture baseline (which could be old).
    const decision = decideScrollWatchdog({
      prevScrollTop: 4500,
      newScrollTop: 3500, // 1000px single-event upward jump
      msSinceUserGesture: 5000,
      itemsLength: 100,
      noGestureBaseline: 5000,
    });
    expect(decision.spurious).toBe(true);
    expect(decision.reason).toBe('big-jump');
    expect(decision.restoreTo).toBe(4500);
  });

  it('does NOT fire on cumulative drift within the gesture grace window', () => {
    // User just wheeled — even if the resulting scroll position
    // looks like big drift from a stale baseline, the user's intent
    // is to be wherever they wheeled to.
    const decision = decideScrollWatchdog({
      prevScrollTop: 4500,
      newScrollTop: 4400,
      msSinceUserGesture: 50,
      itemsLength: 100,
      noGestureBaseline: 5000,
    });
    expect(decision.spurious).toBe(false);
  });

  it('does NOT fire on cumulative drift for short conversations', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 4500,
      newScrollTop: 4400,
      msSinceUserGesture: 5000,
      itemsLength: 5, // below ITEMS_THRESHOLD
      noGestureBaseline: 5000,
    });
    expect(decision.spurious).toBe(false);
  });

  it('does NOT fire on downward drift from baseline (only upward drift is suspect)', () => {
    // Baseline=5000, current=6000 — user has somehow ended up below
    // their gesture baseline. That's not a snap-to-top symptom; the
    // cumulative rule rejects.
    const decision = decideScrollWatchdog({
      prevScrollTop: 5500,
      newScrollTop: 6000,
      msSinceUserGesture: 5000,
      itemsLength: 100,
      noGestureBaseline: 5000,
    });
    expect(decision.spurious).toBe(false);
  });

  it('back-compat: isSpuriousScrollToTop returns false when cumulative-only would fire', () => {
    // The shim doesn't track baseline, so it can ONLY catch the
    // per-event rule. Cumulative-only drift is invisible to it.
    // This is intentional — call sites that don't track baseline
    // shouldn't pretend they do.
    expect(
      isSpuriousScrollToTop({
        prevScrollTop: 4500,
        newScrollTop: 4400, // 100px event jump (under 150 threshold)
        msSinceUserGesture: 5000,
        itemsLength: 100,
      })
    ).toBe(false);
  });
});

describe('decideScrollWatchdog — post-mount window (v4)', () => {
  // Rationale: right after Virtuoso remounts (visKey bump), the
  // scroller is fresh. Virtuoso may briefly land at scrollTop=0
  // before its `initialTopMostItemIndex={LAST,end}` directive runs,
  // and on short conversations the v3 "items > 10" floor lets that
  // through — leaving the user occasionally stranded at the top of
  // a 5-message conversation. v4 drops the items floor for the
  // first POST_MOUNT_WINDOW_MS (500 ms) after the scrollerRef
  // callback captures a new element.

  it('fires for non-zero → 0 within post-mount window even on short lists', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 800,
      newScrollTop: 0,
      msSinceUserGesture: 5000, // long past gesture grace
      itemsLength: 5, // BELOW the items floor
      noGestureBaseline: 800,
      msSincePostMount: 100, // well within the 500ms window
    });
    expect(decision.spurious).toBe(true);
    expect(decision.reason).toBe('post-mount-zero');
    expect(decision.restoreTo).toBe(800);
  });

  it('does NOT fire after the post-mount window expires', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 800,
      newScrollTop: 0,
      msSinceUserGesture: 5000,
      itemsLength: 5,
      noGestureBaseline: 800,
      msSincePostMount: 600, // past the 500ms window
    });
    // Post-mount rule expired AND list is too short for v3 rules.
    expect(decision.spurious).toBe(false);
  });

  it('boundary: exactly 500ms is INSIDE the window (rule is <=)', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 800,
      newScrollTop: 0,
      msSinceUserGesture: 5000,
      itemsLength: 5,
      noGestureBaseline: 800,
      msSincePostMount: 500,
    });
    expect(decision.spurious).toBe(true);
    expect(decision.reason).toBe('post-mount-zero');
  });

  it('boundary: 501ms is OUTSIDE the window', () => {
    const decision = decideScrollWatchdog({
      prevScrollTop: 800,
      newScrollTop: 0,
      msSinceUserGesture: 5000,
      itemsLength: 5,
      noGestureBaseline: 800,
      msSincePostMount: 501,
    });
    expect(decision.spurious).toBe(false);
  });

  it('does NOT fire when prev is too small (avoid false-positive on natural bottom-anchor)', () => {
    // Tiny conversations rest at scrollTop=0 legitimately; we
    // require the prev value to be meaningfully nonzero before
    // we treat 0 as suspicious. POST_MOUNT_MIN_PREV_PX = 100.
    const decision = decideScrollWatchdog({
      prevScrollTop: 50,
      newScrollTop: 0,
      msSinceUserGesture: 5000,
      itemsLength: 5,
      noGestureBaseline: 50,
      msSincePostMount: 100,
    });
    expect(decision.spurious).toBe(false);
  });

  it('does NOT fire within the gesture grace window even during post-mount', () => {
    // User wheeled or pressed PageUp right after mount — honor it
    // even though we're in the post-mount window.
    const decision = decideScrollWatchdog({
      prevScrollTop: 800,
      newScrollTop: 0,
      msSinceUserGesture: 50, // recent gesture
      itemsLength: 5,
      noGestureBaseline: 800,
      msSincePostMount: 100,
    });
    expect(decision.spurious).toBe(false);
  });

  it('does NOT fire when newScrollTop is non-zero (rule targets exactly 0)', () => {
    // The post-mount bug specifically lands at scrollTop=0 (default
    // for a freshly-mounted div). A landing at 50 / 200 / etc. is
    // covered by the big-jump rule on long lists, but NOT by the
    // post-mount rule on short lists — that's intentional, since
    // any non-zero landing requires real evidence of a yank, which
    // means a meaningful items count.
    const decision = decideScrollWatchdog({
      prevScrollTop: 800,
      newScrollTop: 50, // non-zero landing
      msSinceUserGesture: 5000,
      itemsLength: 5,
      noGestureBaseline: 800,
      msSincePostMount: 100,
    });
    expect(decision.spurious).toBe(false);
  });

  it('back-compat: when msSincePostMount is undefined, rule is skipped (v3 semantics)', () => {
    // Callers that don't track mount time omit msSincePostMount;
    // the rule must not accidentally fire from missing data.
    const decision = decideScrollWatchdog({
      prevScrollTop: 800,
      newScrollTop: 0,
      msSinceUserGesture: 5000,
      itemsLength: 5,
      noGestureBaseline: 800,
      // msSincePostMount: undefined
    });
    expect(decision.spurious).toBe(false);
  });

  it('post-mount rule wins over big-jump on long lists (cleaner reason for the same restore)', () => {
    // Both rules would fire here (8000→0 is way past big-jump
    // threshold AND we're in the post-mount window). The post-
    // mount rule is checked first and wins; restoreTo is the same
    // (prevScrollTop) either way, so behavior is identical, only
    // the diagnostic `reason` differs.
    const decision = decideScrollWatchdog({
      prevScrollTop: 8000,
      newScrollTop: 0,
      msSinceUserGesture: 5000,
      itemsLength: 200,
      noGestureBaseline: 8000,
      msSincePostMount: 100,
    });
    expect(decision.spurious).toBe(true);
    expect(decision.reason).toBe('post-mount-zero');
    expect(decision.restoreTo).toBe(8000);
  });
});
