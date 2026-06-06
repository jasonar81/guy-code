import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useApp } from '@/lib/store';
import { ToolCallCard } from './ToolCallCard';
import { RichText } from './RichText';
import { InlineImage } from './InlineImage';
import { SubagentActivity } from './SubagentActivity';
import { LinkifyText } from './LinkifyText';
import { absoluteTime } from '@/lib/format';
import { decideScrollWatchdog } from '@/lib/scrollWatchdog';
import { classifyAssistantText, groupChunks, type ChunkGroup } from '@/lib/narration';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { ChatMessage, ContentBlock } from '@/types';

interface Props {
  sessionId: string;
  /**
   * Whether this pane is currently the visible session in the workspace.
   * MessageList stays mounted across session switches (the parent uses
   * `hidden` attribute to toggle visibility, not unmount), so we need an
   * explicit signal to know when the user JUST switched TO this session.
   * On that transition we force-scroll to bottom regardless of where the
   * user was looking last time — switching sessions always lands at the
   * latest message, matching every other chat app the user has used.
   */
  visible: boolean;
}

/**
 * Scroll behavior invariants (the user's stated rules — DO NOT regress):
 *
 *   1. Switching to a session ALWAYS lands at the latest message.
 *      Implemented via `visKey` bump + Virtuoso's
 *      `initialTopMostItemIndex={index:'LAST', align:'end'}`.
 *
 *   2. If the user is at the bottom AND new content is being written
 *      AND they aren't actively interacting with the scroller, follow
 *      it down. Implemented via `followOutput` (Virtuoso) + the
 *      streaming keep-up rAF nudge in this component. Both are gated
 *      on `mouseDownRef.current` so a drag-to-select doesn't get
 *      yanked back to bottom.
 *
 *   3. If the user is NOT at the bottom AND new content is being
 *      written, do nothing. They're rereading older content; we leave
 *      them alone. Implemented via `atBottomRef.current` checks in
 *      both the keep-up effect and the followOutput callback.
 *
 *   4. The scroll watchdog (see `@/lib/scrollWatchdog`) protects against
 *      Virtuoso re-measurement bugs that yank the user toward the top
 *      without their consent. It treats user gestures (wheel, touch,
 *      keydown, scrollbar drag, content drag) as authoritative and
 *      only fires on UNINTENTIONAL upward jumps.
 *
 * If you find yourself fighting these invariants, you're probably
 * adding a special case the user doesn't want. Push back on the
 * requirement instead.
 */

type ResultsById = Map<string, Extract<ContentBlock, { type: 'tool_result' }>>;

// Singleton fallback used when chat is not yet loaded. Stable identity
// matters: handing out a fresh `new Map()` on every render would
// invalidate every memoized MessageBlock's resultsById prop and defeat
// the whole point of moving the table into the store.
const EMPTY_RESULTS: ResultsById = new Map();

/**
 * Filter out user messages whose content is purely tool_results — those
 * are already shown nested under their tool_use card. The pairing map
 * itself lives in the store (`SessionChat.resultsById`) and is
 * maintained incrementally on every `tool_result` event, so this
 * function no longer needs to walk the message list to build it.
 */
function filterDisplayMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => {
    if (m.role !== 'user') return true;
    return !m.content.every((b) => b.type === 'tool_result');
  });
}

/**
 * Discriminated union for the virtualized list. We mix real chat
 * messages and queued mid-turn interrupts in a single data array so
 * Virtuoso can virtualize both. Each item has a stable string key so
 * Virtuoso can reuse component instances across renders.
 */
type VirtItem =
  | { kind: 'message'; key: string; message: ChatMessage; isStreamingTail: boolean }
  | { kind: 'queued'; key: string; localId: string; text: string }
  | { kind: 'budget-queued'; key: string; text: string; sleepingSince: number | null };

/**
 * Collapsible disclosure for a run of internal-narration paragraphs.
 *
 * v0.1.7 update: the user wanted the muted/dimmer/italic narration
 * paragraphs (memory bookkeeping, "I'll keep going" reassurance,
 * compaction worries, etc.) HIDDEN behind a twisty instead of just
 * de-emphasized. The classifier work in `lib/narration.ts` is
 * unchanged; this component is the new visual presentation.
 *
 * State model:
 *   • Each group renders collapsed by default.
 *   • `forceExpanded=true` (set by the parent when the streaming
 *     cursor lives inside this group) overrides the default so the
 *     user can watch text arrive live instead of just "▶ 1 internal
 *     note".
 *   • Once the user manually clicks the toggle, their explicit
 *     choice sticks for the lifetime of this component instance
 *     (key-stable across re-renders of the same group).
 *
 * Implemented with React state rather than a native `<details>`
 * because we need the auto-expand-on-streaming behavior, which the
 * `<details>` element doesn't give us out of the box.
 */
function NarrationGroup({
  group,
  isStreamingTail,
  isLastBlock,
  totalChunksInBlock,
}: {
  group: ChunkGroup;
  /** True when the parent message is the streaming tail. */
  isStreamingTail: boolean;
  /** True when this group's parent text block is the LAST block of the message. */
  isLastBlock: boolean;
  /** Total number of chunks in the parent block (used to detect "this group owns the last chunk"). */
  totalChunksInBlock: number;
}) {
  // Auto-expand when the streaming cursor sits on the LAST chunk of
  // the LAST block AND that chunk falls inside this group. Without
  // this, a muted final paragraph would stream into a collapsed
  // twisty showing only "▶ 1 internal note" — the user would lose
  // the streaming-progress signal entirely.
  const containsStreamingTail =
    isStreamingTail && isLastBlock && group.lastIndex === totalChunksInBlock - 1;

  // Three-valued: null = user has not touched the twisty, defer to
  // `forceExpanded`. Once they click, their value sticks.
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled !== null ? userToggled : containsStreamingTail;

  const count = group.chunks.length;
  const summaryLabel = `${count} internal note${count === 1 ? '' : 's'}`;

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        className={clsx(
          'inline-flex items-center gap-1 rounded px-1 -mx-1 py-0.5',
          'text-[10px] text-text-dim italic opacity-80 hover:opacity-100 hover:bg-bg-hover',
          'transition-opacity select-none'
        )}
        title={
          expanded
            ? 'Hide internal notes (memory / status / compaction self-talk)'
            : 'Show internal notes (memory / status / compaction self-talk)'
        }
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={10} className="shrink-0" />
        ) : (
          <ChevronRight size={10} className="shrink-0" />
        )}
        <span>{summaryLabel}</span>
      </button>
      {expanded && (
        <div className="space-y-1.5 border-l border-border/60 pl-2 ml-1">
          {group.chunks.map((c, ci) => {
            const isLastChunkInGroup = ci === group.chunks.length - 1;
            const showCursor = containsStreamingTail && isLastChunkInGroup;
            return (
              <div
                key={ci}
                title="Filtered as internal-state narration (memory / compaction / status pings). The text is still here — just visually de-emphasized."
                className={clsx(
                  'text-[11px] text-text-dim italic opacity-80 break-words',
                  showCursor &&
                    'after:content-["▍"] after:ml-0.5 after:text-accent after:animate-pulse'
                )}
              >
                <RichText text={c.text} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function MessageList({ sessionId, visible }: Props) {
  const chat = useApp((s) => s.chats[sessionId]);
  const messages = chat?.messages ?? [];
  const streaming = chat?.streaming ?? false;
  const queued = chat?.pendingInterrupts ?? [];
  const removeInterrupt = useApp((s) => s.removeInterrupt);
  const cancelPending = useApp((s) => s.cancelPending);
  // Pull the persisted budget-queued reply from the session row.
  // This is the message the user typed while (or which triggered) the
  // session entering sleeping-budget state — it's stored in SQLite
  // (sessions.pending_user_text) so it survives app restart. Without
  // surfacing it in the chat the user has no way to know their reply
  // is actually queued and will fire at the next-hour rollover.
  const sessionRow = useApp((s) => s.sessions.find((r) => r.id === sessionId));
  const budgetQueuedText = sessionRow?.pending_user_text ?? null;
  const sleepingSince = sessionRow?.sleeping_since ?? null;

  // resultsById lives in the store now and is updated incrementally on
  // tool_result events. We grab the ref here; memoized MessageBlocks
  // use reference equality (and a per-message tool_use scan) to decide
  // whether to re-render.
  const resultsById: ResultsById = chat?.resultsById ?? EMPTY_RESULTS;
  const display = useMemo(() => filterDisplayMessages(messages), [messages]);

  // Build the virtualized item list. Each item carries everything its
  // renderer needs so the itemContent callback can stay pure (and
  // therefore Virtuoso's internal memoization works). Recomputed only
  // when messages / queued / streaming change.
  const items = useMemo<VirtItem[]>(() => {
    const list: VirtItem[] = [];
    const lastIdx = display.length - 1;
    for (let i = 0; i < display.length; i++) {
      const m = display[i];
      list.push({
        kind: 'message',
        key: m.localId,
        message: m,
        isStreamingTail: streaming && i === lastIdx && m.role === 'assistant',
      });
    }
    for (const q of queued) {
      list.push({
        kind: 'queued',
        key: `q-${q.localId}`,
        localId: q.localId,
        text: q.text,
      });
    }
    // Budget-queued reply lives at the very end of the list. The user
    // is meant to read it as "this is the message that will fire at
    // the top of the next hour" — putting it visually below all real
    // messages and any mid-turn queued interrupts matches that
    // semantic.
    if (budgetQueuedText && budgetQueuedText.trim().length > 0) {
      list.push({
        kind: 'budget-queued',
        key: 'budget-queued',
        text: budgetQueuedText,
        sleepingSince,
      });
    }
    return list;
  }, [display, queued, streaming, budgetQueuedText, sleepingSince]);

  // Virtuoso instance handle for imperative scroll (used to pin the
  // bottom while streaming if the user is following, and to force the
  // initial bottom anchor when the user switches to this pane).
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // Mirror of Virtuoso's atBottom signal. We need it in JS-land so the
  // streaming-keep-up effect knows whether to nudge scrollToIndex when
  // the last item grows mid-stream (followOutput only fires on data
  // array length change; mid-item height growth doesn't trigger it).
  const atBottomRef = useRef(true);
  // Underlying DOM scroller (the element Virtuoso owns). Captured via
  // the `scrollerRef` callback prop so the scroll-top watchdog below
  // can attach listeners and read/restore scrollTop directly. Virtuoso
  // also exposes Window as a possible scroller in the type union, but
  // we never use customScrollParent / useWindowScroll, so it's always
  // an HTMLElement in practice; we still narrow defensively.
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // Timestamp of the last *user-driven* scroll gesture (wheel, touch,
  // keydown PageDown/Up, mouse drag on the scrollbar). The watchdog
  // uses this to distinguish intentional scroll-to-top (which we
  // never fight) from spurious scrollTop=0 transitions caused by
  // Virtuoso re-measurements during parent layout shifts.
  const lastUserScrollAtRef = useRef(0);
  // Last observed scrollTop for the watchdog to restore from. Updated
  // on every scroll event. We snapshot ALL scrollTops (not just
  // non-zero ones) so the restore target is the position the user
  // was just looking at — not some stale value from minutes ago.
  const lastScrollTopRef = useRef(0);
  // Cumulative-drift baseline: the scrollTop at the last user
  // gesture. Updated on every gesture (wheel/touch/keydown/scrollbar
  // mousedown), and during the gesture's grace window so a wheel
  // landing slightly after the keydown also pulls the baseline
  // forward. The cumulative-drift watchdog rule (scrollWatchdog.ts
  // v3) uses this to detect slow, multi-event upward yanks that
  // individually slip under the per-event 150 px threshold but
  // collectively shift the user hundreds of px from where they were.
  const noGestureBaselineRef = useRef(0);
  // Timestamp (ms via Date.now) of the most recent scroller-element
  // mount, captured by the `scrollerRef` callback when Virtuoso
  // hands us its underlying DOM node. The watchdog uses this to
  // identify scroll events arriving in the post-mount window
  // (typically the first 500 ms after a remount) and apply tighter
  // rules — Virtuoso can briefly land at scrollTop=0 in that window
  // before its `initialTopMostItemIndex` directive runs, and on
  // short conversations the v3 "items > 10" floor lets that
  // through. See `scrollWatchdog.ts` v4 changelog.
  const mountAtRef = useRef(0);

  // followOutput tells Virtuoso how to behave when the data array
  // grows: 'auto' = jump to bottom; false = leave the user where they
  // are. We use 'auto' (not 'smooth') because smooth scrolling lags
  // behind rapid text_delta updates and produces the "catches up
  // late" feeling the user reported. The boolean arg is Virtuoso's
  // own atBottom signal, more accurate than our state in the moment
  // of the data change.
  //
  // Suppress while the user has the mouse held down on the scroller.
  // Virtuoso's followOutput races the browser's native auto-scroll-
  // during-text-selection — Virtuoso writes scrollTop directly via
  // scrollToIndex while the browser tries to scroll a few px per
  // frame, and Virtuoso wins. Result without this gate: drag-to-
  // select-upward from the bottom can't extend past the viewport
  // edge because every text_delta reanchors to bottom faster than
  // the browser can scroll up. The mouseDownRef tracks both content
  // drags and scrollbar drags, so this defers to native behavior in
  // both cases. The closure resolves mouseDownRef at CALL time
  // (Virtuoso invokes this callback after render), so forward-
  // referencing the ref declared further down the function body is
  // safe.
  const followOutput = useCallback(
    (isAtBottom: boolean): false | 'smooth' | 'auto' => {
      if (mouseDownRef.current) return false;
      return isAtBottom ? 'auto' : false;
    },
    []
  );

  const onAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
  }, []);

  /**
   * Visibility-remount key. Increments every time the pane goes
   * false→true so the Virtuoso instance below remounts. We tried
   * keeping a single Virtuoso instance and firing scrollToIndex over
   * many rAF frames after the visibility flip, but the
   * display:none↔display:block transition (driven by the parent
   * SessionPane's `hidden` attribute) leaves Virtuoso's internal
   * ResizeObserver measurements stale, and scrollToIndex with
   * align:'end' would clamp scrollTop to 0 mid-retry — which is
   * exactly the "snaps to top on session switch" UX bug.
   *
   * Remounting forces `initialTopMostItemIndex={LAST, end}` to apply
   * fresh, with measurements taken AFTER the parent has flipped to
   * display:block. The cost is re-measuring all currently-rendered
   * items on the next tick; for typical session sizes this is
   * sub-frame, and it matches the existing UX intent ("switching
   * sessions always lands at the latest message").
   */
  const [visKey, setVisKey] = useState(0);
  useEffect(() => {
    if (visible) {
      // Diagnostic: log every visKey bump so if a user reports
      // "session flipped to bottom unexpectedly" we have evidence
      // of how many remounts fired and when. visKey bumps are
      // SUPPOSED to fire only on a real session-pane visibility
      // flip (false→true), but a parent component re-render that
      // briefly toggles `visible` would cause a spurious bump.
      // Cheap: one console line per real session switch.
      // eslint-disable-next-line no-console
      console.info(
        `[MessageList] visKey bump for session ${sessionId.slice(0, 8)} → Virtuoso will remount and land at LAST/end`
      );
      setVisKey((k) => k + 1);
    }
  }, [visible, sessionId]);

  /**
   * Bottom-pin nudge for streaming. When the last assistant message
   * grows mid-stream (text_delta / tool_use_input_delta clones) the
   * `data` array reference changes but its length stays the same, so
   * Virtuoso's `followOutput` doesn't fire. We have to manually nudge.
   *
   * One-shot per items reference change — no multi-frame retry. The
   * remount above already handles the "measurements not settled" case,
   * so this only runs when Virtuoso is already mounted-and-measured
   * and we just need a small nudge to keep the streaming tail in view.
   */
  const fireScrollToBottom = useCallback(() => {
    const lastIndex = items.length - 1;
    if (lastIndex < 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: lastIndex,
      align: 'end',
      behavior: 'auto',
    });
  }, [items.length]);

  /**
   * Streaming keep-up effect.
   *
   * When tokens stream INTO the last assistant message, the data
   * array reference changes (we clone-on-write in the store) but
   * `items.length` stays the same. Virtuoso's `followOutput` only
   * fires on length changes, so mid-message growth doesn't trigger
   * it. We have to manually nudge.
   *
   * Gate: only nudge if the user was at-bottom before this items
   * reference change. If they scrolled up to read history,
   * `atBottomRef.current` flipped false and we leave them alone —
   * fighting that gesture is the worst possible UX.
   *
   * Coalesced via rAF: a fast text_delta stream produces 50–200
   * items-reference updates per second, each of which would otherwise
   * fire `scrollToIndex`. That's enough to occasionally race with
   * Virtuoso's internal re-measure pass and produce a wrong scrollTop.
   * The rAF gate collapses any number of updates within a single
   * frame into one nudge — same UX, far less pressure on the layout
   * engine.
   */
  const scrollNudgePendingRef = useRef(false);
  useEffect(() => {
    if (!streaming) return;
    if (!atBottomRef.current) return;
    if (items.length === 0) return;
    // Suppress the auto-keep-up nudge while the user has the mouse
    // held down on the scroller. Otherwise a drag-to-select
    // upward gets fought back to bottom on every text_delta — the
    // user can't extend the selection past the viewport edge
    // because the keep-up effect re-anchors faster than the
    // browser's native auto-scroll-during-selection can drag away.
    // mouseDownRef is reset on mouseup, so the keep-up resumes the
    // moment the user releases.
    if (mouseDownRef.current) return;
    if (scrollNudgePendingRef.current) return;
    scrollNudgePendingRef.current = true;
    const id = requestAnimationFrame(() => {
      scrollNudgePendingRef.current = false;
      // Re-check atBottom AND mouseDown inside the rAF — the user
      // may have scrolled up OR started a drag between the effect
      // firing and the frame landing.
      if (!atBottomRef.current) return;
      if (mouseDownRef.current) return;
      fireScrollToBottom();
    });
    return () => {
      cancelAnimationFrame(id);
      scrollNudgePendingRef.current = false;
    };
  }, [items, streaming, fireScrollToBottom]);

  /**
   * Mid-session scroll-to-top watchdog.
   *
   * Symptom: while the user is sitting in a session (NOT switching),
   * the chat occasionally snaps to the top of the conversation. The
   * underlying cause is some combination of (a) Virtuoso v4.18.x
   * re-measurements when the parent flex layout shrinks (Composer
   * textarea growing as the user types, CurrentPlanPanel
   * appearing/collapsing on TodoWrite), (b) above-viewport item
   * height changes during streaming, and (c) `data` reference churn
   * during fast text_delta storms. None of these reliably reproduce
   * in isolation.
   *
   * Rather than chase each cause individually, install a defense:
   *
   *   - Track the user's intentional scroll gestures (wheel, touch,
   *     keydown, scrollbar drag → mousedown on the scroller). Any
   *     scrollTop change within 200ms of one of those is "intended"
   *     and we leave it alone, even if it lands at 0.
   *
   *   - Snapshot scrollTop on every scroll event.
   *
   *   - When scrollTop transitions to 0 (or near-0) WITHOUT a recent
   *     user gesture AND the list has more than a handful of items,
   *     restore the previous scrollTop. This is a defensive write —
   *     if Virtuoso was about to re-paint anyway, our restoration
   *     gets the user back to where they were before the next paint
   *     lands.
   *
   * The threshold (10 items) avoids false-positive restoration on
   * tiny lists where scrollTop=0 is a legitimate resting state.
   */
  // True between mousedown and mouseup ON the scroller — i.e., while
  // the user is actively dragging the scrollbar handle. The watchdog
  // uses this as an unconditional "honor every scroll" override:
  // dragging the scrollbar produces a continuous stream of scroll
  // events with the cursor pinned outside any standard "user gesture"
  // signal — the only mousedown was at the start of the drag, and
  // its 200 ms grace window expires long before a slow upward drag
  // finishes. Without this flag, mid-drag scroll events past the
  // grace window get classified as spurious and yanked back, which
  // is exactly the "drag up sticks, drag down works" symptom from
  // before this fix.
  const isDraggingRef = useRef(false);
  // True between any primary-button mousedown ON the scroller and
  // its corresponding mouseup. Strictly broader than `isDraggingRef`:
  // includes content drags (text selection), not just scrollbar
  // drags. The streaming-keep-up effect uses this to suppress its
  // auto-scroll-to-bottom nudge while the user is actively
  // interacting with the scroller — without this gate, a drag-to-
  // select-upward during a streaming response yanks the user back
  // to the bottom on every text_delta, making it impossible to
  // extend a selection upward past the viewport edge. The watchdog
  // uses it to keep the cumulative-drift baseline pinned to the
  // current scrollTop for the duration of the drag, so the browser's
  // native auto-scroll-during-selection (small per-frame steps that
  // accumulate into a multi-hundred-px total) doesn't trip the
  // drift rule.
  const mouseDownRef = useRef(false);

  useEffect(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    const markUserScroll = () => {
      lastUserScrollAtRef.current = Date.now();
      // Reset the cumulative-drift baseline to the current scrollTop
      // every time a fresh gesture lands. Without this, baseline
      // would forever reflect the very first gesture and any
      // legitimate user-driven scroll over time would look like a
      // huge "drift" to the watchdog.
      noGestureBaselineRef.current = el.scrollTop;
    };
    const onMouseDown = (e: MouseEvent) => {
      // Only the primary button — middle-click autoscroll on Windows
      // and right-click context menu shouldn't open the override.
      if (e.button !== 0) {
        markUserScroll();
        return;
      }
      // Track ALL primary mousedowns on the scroller (regardless of
      // whether they hit the scrollbar or the content) so the
      // streaming-keep-up effect can suppress its auto-scroll-to-
      // bottom nudge for the duration of the drag — otherwise a
      // text-selection drag-upward gets fought back to the bottom.
      mouseDownRef.current = true;
      // Distinguish "click on the scrollbar (handle or track)" from
      // "click on the content (e.g. starting a text selection)".
      // `offsetX` is measured from the element's padding edge inside
      // its border. `clientWidth` is the inner width MINUS the
      // vertical scrollbar gutter. So when the cursor is past
      // `clientWidth`, it's over the scrollbar — that's the only
      // case where we want the FULL watchdog override on (bypass
      // BOTH big-jump and cumulative-drift rules). For content drags
      // the cumulative-drift rule still gets pinned to current via
      // mouseDownRef in the scroll handler, but big-jump remains
      // active so a layout shift mid-selection still fights back.
      const onScrollbar = e.offsetX > el.clientWidth;
      if (onScrollbar) isDraggingRef.current = true;
      markUserScroll();
    };
    // mouseup MUST be on window — the user can release outside the
    // scroller (drags often track off the element), and we MUST hear
    // about it or the dragging flag stays true forever, leaving the
    // watchdog disabled until the next mousedown.
    const onMouseUp = () => {
      const wasInteracting = mouseDownRef.current || isDraggingRef.current;
      mouseDownRef.current = false;
      if (isDraggingRef.current) isDraggingRef.current = false;
      if (wasInteracting) {
        // Treat the release itself as a fresh user gesture — gives
        // the watchdog its normal 200 ms grace window for any final
        // settling scroll events the browser fires post-release.
        markUserScroll();
      }
    };
    const onScroll = () => {
      const cur = el.scrollTop;
      const prev = lastScrollTopRef.current;
      // Active scrollbar drag → unconditionally honor. The watchdog
      // is for fighting Virtuoso re-measurement jumps, not user
      // gestures. ALSO pull the cumulative-drift baseline along
      // with the drag so a user dragging from y=2000 to y=200 doesn't
      // immediately retrigger the cumulative rule on the next
      // post-release scroll event.
      if (isDraggingRef.current) {
        lastScrollTopRef.current = cur;
        noGestureBaselineRef.current = cur;
        return;
      }
      // Content drag (text selection in progress, mouse held down):
      // pin the cumulative-drift baseline to the current scrollTop
      // every event, so the browser's native auto-scroll-during-
      // selection (small per-frame steps) doesn't accumulate into a
      // multi-hundred-px "drift" that trips the cumulative rule and
      // yanks the user mid-selection. The big-jump rule stays
      // active — a layout shift during selection (>150 px in a
      // single event) is still spurious and we still fight it.
      if (mouseDownRef.current) {
        noGestureBaselineRef.current = cur;
      }
      const sinceUserMs = Date.now() - lastUserScrollAtRef.current;
      // mountAtRef is 0 before the first scrollerRef capture; treat
      // that as "no mount recorded yet" by passing undefined so the
      // post-mount rule short-circuits (back-compat semantics).
      const sincePostMount =
        mountAtRef.current > 0 ? Date.now() - mountAtRef.current : undefined;
      // Decision rule lives in `@/lib/scrollWatchdog` so it can be
      // unit-tested without mounting the whole component.
      const decision = decideScrollWatchdog({
        prevScrollTop: prev,
        newScrollTop: cur,
        msSinceUserGesture: sinceUserMs,
        itemsLength: items.length,
        noGestureBaseline: noGestureBaselineRef.current,
        msSincePostMount: sincePostMount,
      });
      if (decision.spurious && decision.restoreTo !== undefined) {
        const restoreTo = decision.restoreTo;
        // Restore. Use scrollTo (not scrollTop = ...) because the
        // scroller may be inside a container Virtuoso owns; scrollTo
        // honors smooth-vs-instant scroll mode the same way the user's
        // earlier gesture did. instant restore is what we want here.
        el.scrollTo({ top: restoreTo, behavior: 'instant' as ScrollBehavior });
        // Diagnostic is now ALWAYS on (was gated on
        // localStorage.scrollDebug === '1'). The watchdog only fires
        // a handful of times per session — and only on actually-
        // spurious jumps that we already considered worth fighting
        // — so the log volume is negligible. Always-on means when
        // the user reports "still seeing scroll-to-top", we have the
        // evidence in DevTools without asking them to flip a flag
        // beforehand.
        // eslint-disable-next-line no-console
        console.warn(
          `[MessageList] watchdog (${decision.reason}): restored scrollTop ${restoreTo} from ${cur} ` +
            `(prev=${prev}, baseline=${noGestureBaselineRef.current}, ` +
            `items=${items.length}, sinceUserMs=${sinceUserMs}, sincePostMountMs=${sincePostMount})`
        );
        // Don't update lastScrollTopRef from the restore itself —
        // the next scroll event for the restored position will
        // arrive shortly and update it then.
        return;
      }
      // Forensic trace for near-zero scrolls that the watchdog
      // DECLINED to fight. The user has repeatedly reported residual
      // scroll-to-top cases that the current rules don't catch; this
      // log captures the inputs to the rule when a candidate (large
      // upward jump landing near zero, no gesture) gets through, so
      // we can see exactly which condition rejected the fire and
      // tighten the rule. Cheap: only fires when both conditions are
      // suspicious, which itself is rare.
      const isSuspiciousButNotFlagged =
        cur < 100 &&
        prev - cur > 100 &&
        sinceUserMs > 200 &&
        !isDraggingRef.current &&
        !mouseDownRef.current;
      if (isSuspiciousButNotFlagged) {
        // eslint-disable-next-line no-console
        console.warn(
          `[MessageList] watchdog NO-FIRE on suspicious near-zero scroll: ` +
            `prev=${prev} → cur=${cur} (jump=${prev - cur}), ` +
            `items=${items.length}, sinceUserMs=${sinceUserMs}, ` +
            `sincePostMountMs=${sincePostMount ?? 'undef'}, ` +
            `baseline=${noGestureBaselineRef.current}, drift=${noGestureBaselineRef.current - cur}`
        );
      }
      lastScrollTopRef.current = cur;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', markUserScroll, { passive: true });
    el.addEventListener('touchstart', markUserScroll, { passive: true });
    el.addEventListener('keydown', markUserScroll);
    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', markUserScroll);
      el.removeEventListener('touchstart', markUserScroll);
      el.removeEventListener('keydown', markUserScroll);
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      // If the user happened to be mid-drag when this effect tore
      // down (e.g., session switched during a drag), reset state
      // so the next mount starts clean. We DON'T reset
      // `mouseDownRef` here: the effect can re-bind mid-drag
      // (items.length change while user holds mouse down) on the
      // SAME DOM scroller; clearing the flag in that case would
      // cause the streaming-keep-up effect to immediately yank
      // the user back to bottom while they're still selecting.
      // The window-level mouseup listener still fires on the new
      // effect instance, so the flag clears correctly when the
      // user actually releases.
      isDraggingRef.current = false;
    };
    // Re-bind when the scroller element changes (Virtuoso remounts on
    // visKey bump, which gives us a new HTMLElement) and when items
    // changes — the items length is captured in the closure so the
    // SCROLL_TOP_THRESHOLD compare reads a fresh value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerElRef.current, items.length]);

  const itemContent = useCallback(
    (_index: number, item: VirtItem) => {
      if (item.kind === 'message') {
        return (
          <div className="max-w-3xl mx-auto px-5 py-2">
            <MessageBlock
              message={item.message}
              resultsById={resultsById}
              isStreamingTail={item.isStreamingTail}
            />
          </div>
        );
      }
      if (item.kind === 'budget-queued') {
        // Compute next-hour wake time for the tooltip. The resume sweep
        // fires at the top of each hour, so this is when the queued
        // message will auto-send (assuming the budget hasn't
        // re-saturated by then).
        const now = new Date();
        const nextHour = new Date(now);
        nextHour.setHours(now.getHours() + 1, 0, 0, 0);
        const wakeStr = nextHour.toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        });
        return (
          <div className="max-w-3xl mx-auto px-5 py-2">
            <div className="flex flex-col items-end gap-0.5 group">
              <div
                className="relative max-w-[85%] rounded-lg bg-state-attention/5 border border-state-attention/50 px-3 py-2 text-[13px] text-text whitespace-pre-wrap break-words select-text"
                title={`Will auto-send at ${wakeStr} when the hourly budget refills. Click × to cancel.`}
              >
                {item.text}
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        'Cancel this queued reply? It will not be sent at the next hour rollover.'
                      )
                    ) {
                      cancelPending(sessionId);
                    }
                  }}
                  className="absolute -top-2 -right-2 hidden group-hover:inline-flex items-center justify-center w-5 h-5 rounded-full bg-bg-elevated border border-border text-text-dim hover:text-state-error hover:border-state-error/40 text-[11px]"
                  title="Cancel queued reply"
                  aria-label="Cancel queued reply"
                >
                  ×
                </button>
              </div>
              <span className="text-[10px] text-state-attention font-mono">
                💤 budget-paused · auto-sends at {wakeStr} · click × to cancel
              </span>
            </div>
          </div>
        );
      }
      // item.kind === 'queued' (mid-turn interrupt)
      return (
        <div className="max-w-3xl mx-auto px-5 py-2">
          <div className="flex flex-col items-end gap-0.5 group">
            <div
              className="relative max-w-[85%] rounded-lg bg-bg-elevated/50 border border-state-attention/40 px-3 py-2 text-[13px] text-text-muted italic whitespace-pre-wrap break-words select-text"
              title="Queued — the agent will pick this up between tool rounds"
            >
              {item.text}
              <button
                onClick={() => removeInterrupt(sessionId, item.localId)}
                className="absolute -top-2 -right-2 hidden group-hover:inline-flex items-center justify-center w-5 h-5 rounded-full bg-bg-elevated border border-border text-text-dim hover:text-state-error hover:border-state-error/40 text-[11px]"
                title="Remove from queue"
                aria-label="Remove queued message"
              >
                ×
              </button>
            </div>
            <span className="text-[10px] text-state-attention font-mono">
              ⏳ queued · click × to remove
            </span>
          </div>
        </div>
      );
    },
    [resultsById, removeInterrupt, cancelPending, sessionId]
  );

  const computeItemKey = useCallback(
    (_index: number, item: VirtItem) => item.key,
    []
  );

  // Empty state: render the placeholder ONLY when the chat has never
  // been loaded yet OR the underlying message list is genuinely empty.
  // We intentionally do NOT short-circuit just because `items.length
  // === 0` — `items` is a derived array (filterDisplayMessages +
  // queued + budget-queued). It can transiently drop to 0 during a
  // history reload while `messages.length` is mid-replacement, and
  // unmounting Virtuoso on that flicker forces a remount which
  // re-applies `initialTopMostItemIndex`. Mounting Virtuoso with an
  // empty `data` array is well-supported and avoids that whole class
  // of remount-driven scroll resets.
  const hasNeverLoaded = chat == null || (!chat.loaded && messages.length === 0);
  if (hasNeverLoaded && items.length === 0) {
    return (
      <div className="flex-1 overflow-hidden flex items-center justify-center text-text-dim text-[12px]">
        Type a message below to start.
      </div>
    );
  }

  return (
    <Virtuoso<VirtItem>
      // Remount on visibility flip — see visKey comment above.
      // sessionId in the key as well so a session-switch that lands on
      // the same SessionPane (theoretically possible during reorder
      // animations) also gets a fresh Virtuoso.
      key={`${sessionId}-${visKey}`}
      ref={virtuosoRef}
      // Capture the underlying scroller HTMLElement for the watchdog
      // (see useEffect above). Virtuoso's typed callback union allows
      // Window | HTMLElement | null; we narrow to HTMLElement since
      // we never enable customScrollParent or useWindowScroll.
      scrollerRef={(el) => {
        const next = el instanceof HTMLElement ? el : null;
        // Stamp mount time only when the element actually changed —
        // Virtuoso calls scrollerRef on every render in some
        // versions, and we want the timestamp to reflect actual
        // remounts (visKey bump → fresh DOM node), not noise.
        if (next !== scrollerElRef.current) {
          scrollerElRef.current = next;
          if (next !== null) {
            mountAtRef.current = Date.now();
            // Reset scroll-state refs to whatever the fresh element
            // reports right now. Without this, the watchdog's
            // post-mount rule would compare against stale values
            // from the previous Virtuoso instance.
            lastScrollTopRef.current = next.scrollTop;
            noGestureBaselineRef.current = next.scrollTop;
          }
        }
      }}
      data={items}
      computeItemKey={computeItemKey}
      itemContent={itemContent}
      followOutput={followOutput}
      atBottomStateChange={onAtBottomStateChange}
      // Canonical Virtuoso "start at bottom" syntax. The plain-index
      // form (`{Math.max(0, items.length - 1)}`) defaults to
      // align:'start' — which puts the last item at the TOP of the
      // viewport with empty space below, NOT at the bottom. That was
      // the literal "scrolled to top on session open" bug. The object
      // form with align:'end' lands the item's bottom edge at the
      // viewport's bottom edge, which is what "start at bottom"
      // actually means.
      initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
      // Generous threshold so a single wheel tick near the bottom
      // doesn't disengage follow. Mirrors the old `rootMargin: '0px 0px
      // 64px 0px'` IntersectionObserver tolerance.
      atBottomThreshold={64}
      // Render a small overscan so scrolling feels smooth without
      // mounting too many off-screen MessageBlocks.
      increaseViewportBy={{ top: 200, bottom: 400 }}
      // `min-h-0` lets this flex child shrink below its content's min-content
      // height. Without it, a tall sibling (e.g. a long plan panel) could
      // overflow the flex column and push the composer off-screen instead of
      // the transcript yielding space. Pairs with the plan panel's max-height
      // cap as defense-in-depth so the input box is always reachable.
      className="flex-1 min-h-0 select-text"
      style={{ height: '100%' }}
    />
  );
}

interface MessageBlockProps {
  message: ChatMessage;
  resultsById: ResultsById;
  isStreamingTail: boolean;
}

/**
 * Memoization comparator for MessageBlock. Returns `true` to skip render.
 *
 * Skip conditions (in order, cheapest first):
 *   1. Different message ref → must render (content changed).
 *   2. Different `isStreamingTail` → must render (tail cursor flips).
 *   3. Same `resultsById` ref → no tool_result event since last render,
 *      so any results referenced by this message are unchanged. Skip.
 *   4. New `resultsById` ref → SOME tool_result arrived, but probably
 *      not for this message. Walk the message's tool_use blocks and
 *      check whether any of THEIR specific results changed identity.
 *      Skip iff none did.
 *
 * For Channel Factory's thousands of historical messages, every
 * tool_result event hits step 3 for nearly all of them and steps 1/2
 * for the rest, keeping per-event work O(1) per inactive message
 * instead of O(N × M) reconciliation.
 */
function messageBlockPropsEqual(prev: MessageBlockProps, next: MessageBlockProps): boolean {
  if (prev.message !== next.message) return false;
  if (prev.isStreamingTail !== next.isStreamingTail) return false;
  if (prev.resultsById === next.resultsById) return true;
  // resultsById ref changed → check only the tool_uses owned by this
  // message. For messages with no tool_use blocks (the common case for
  // historical assistant text and user messages) this is O(message
  // content length), typically 1-3 entries.
  for (const b of next.message.content) {
    if (b.type !== 'tool_use') continue;
    if (prev.resultsById.get(b.id) !== next.resultsById.get(b.id)) return false;
  }
  return true;
}

function MessageBlockImpl({
  message,
  resultsById,
  isStreamingTail,
}: MessageBlockProps) {
  if (message.role === 'user') {
    // Filter out any tool_result blocks (already shown nested)
    const blocks = message.content.filter((b) => b.type !== 'tool_result');
    if (blocks.length === 0) return null;
    // Split text from media so images/PDFs render BELOW the text in a more
    // chat-like layout: text bubble first, then thumbnail row.
    const textBlocks = blocks.filter((b) => b.type === 'text');
    const imageBlocks = blocks.filter((b) => b.type === 'image');
    const docBlocks = blocks.filter((b) => b.type === 'document');
    return (
      <div className="flex flex-col items-end gap-1">
        {textBlocks.length > 0 && (
          <div className="max-w-[85%] rounded-lg bg-bg-elevated border border-border px-3 py-2 text-[13px] text-text whitespace-pre-wrap break-words select-text">
            {textBlocks.map((b, i) =>
              // User messages go through LinkifyText (URLs become clickable
              // but markdown-special characters aren't interpreted). Assistant
              // output below uses full GFM markdown rendering.
              b.type === 'text' ? <LinkifyText key={i} text={b.text} /> : null
            )}
          </div>
        )}
        {(imageBlocks.length > 0 || docBlocks.length > 0) && (
          <div className="max-w-[85%] flex flex-wrap justify-end gap-1.5">
            {imageBlocks.map((b, i) =>
              b.type === 'image' ? (
                <img
                  key={`img-${i}`}
                  src={`data:${b.source.media_type};base64,${b.source.data}`}
                  alt={b.name ?? 'attached image'}
                  className="max-h-48 max-w-[200px] rounded-md border border-border object-contain bg-bg"
                  title={b.name}
                />
              ) : null
            )}
            {docBlocks.map((b, i) =>
              b.type === 'document' ? (
                <div
                  key={`doc-${i}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-2 py-1.5 text-[11px] text-text-muted"
                  title={b.name ?? 'PDF document'}
                >
                  <span className="text-state-attention">📄</span>
                  <span className="truncate max-w-[180px] text-text">
                    {b.name ?? 'document.pdf'}
                  </span>
                </div>
              ) : null
            )}
          </div>
        )}
        <MessageTimestamp ts={message.ts} />
      </div>
    );
  }

  // Assistant
  return (
    <div className="space-y-1.5 select-text">
      <MessageTimestamp ts={message.ts} />
      {message.content.map((b, i) => {
        if (b.type === 'text') {
          // Assistant text uses full GFM markdown rendering via RichText.
          // We deliberately DON'T set whitespace-pre-wrap here: markdown
          // emits paragraph / list / table elements that handle their own
          // spacing, and pre-wrap would cause raw newlines inside paragraph
          // text nodes to render as literal line breaks.
          //
          // v0.1.5: classify each paragraph as "internal narration" or
          // "substantive content". Narration paragraphs (memory /
          // compaction / self-reassurance noise) render in a smaller,
          // dimmer font so the eye doesn't have to wade through them.
          // The chunker respects fenced code blocks; never mutes code.
          // See `src/lib/narration.ts` for the rules + rationale.
          const chunks = classifyAssistantText(b.text);
          const isLast = i === message.content.length - 1;
          // If the chunker returned nothing (empty / whitespace block)
          // we still render the original to keep the streaming cursor
          // attached to the right element while the model is typing.
          if (chunks.length === 0) {
            return (
              <div
                key={i}
                className={clsx(
                  'text-[13px] text-text break-words',
                  isStreamingTail &&
                    isLast &&
                    'after:content-["▍"] after:ml-0.5 after:text-accent after:animate-pulse'
                )}
              >
                <RichText text={b.text} />
              </div>
            );
          }
          // v0.1.7: group consecutive muted chunks into runs so they
          // can collapse behind a single twisty (one disclosure per
          // run, not one per paragraph). Normal chunks render inline
          // as before. The streaming cursor still sits on the final
          // chunk of the final block — that's now either a normal
          // chunk (rendered directly) or a muted chunk inside a
          // NarrationGroup which auto-expands while streaming.
          const groups = groupChunks(chunks);
          return (
            <div key={i} className="space-y-1.5">
              {groups.map((g, gi) => {
                if (g.kind === 'muted') {
                  return (
                    <NarrationGroup
                      key={gi}
                      group={g}
                      isStreamingTail={isStreamingTail}
                      isLastBlock={isLast}
                      totalChunksInBlock={chunks.length}
                    />
                  );
                }
                // Normal group: render each chunk as plain assistant
                // text. The streaming cursor sits on the FINAL chunk
                // of the FINAL block — which is only this group when
                // it owns the last chunk index in the whole block.
                return (
                  <div key={gi} className="space-y-1.5">
                    {g.chunks.map((c, ci) => {
                      const chunkIndex = g.firstIndex + ci;
                      const isLastChunk = chunkIndex === chunks.length - 1;
                      const showCursor =
                        isStreamingTail && isLast && isLastChunk;
                      return (
                        <div
                          key={ci}
                          className={clsx(
                            'text-[13px] text-text break-words',
                            showCursor &&
                              'after:content-["▍"] after:ml-0.5 after:text-accent after:animate-pulse'
                          )}
                        >
                          <RichText text={c.text} />
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          );
        }
        if (b.type === 'image') {
          // Assistant image content block (e.g. a tool-pushed screenshot or a
          // generated picture). Render it inline + clickable (copy / save).
          return (
            <InlineImage
              key={i}
              src={`data:${b.source.media_type};base64,${b.source.data}`}
              alt={b.name ?? 'image'}
            />
          );
        }
        if (b.type === 'subagent') {
          return <SubagentActivity key={`sa-${b.runId}`} block={b} />;
        }
        if (b.type === 'tool_use') {
          // WaitForUser is the model's way of saying "I need an answer from
          // the human." Treat its `question` input as inline assistant text
          // (rendered as markdown) rather than a generic tool card — the
          // question is the message, not a debugging detail. The "needs you"
          // status pill on the composer already signals the session state.
          if (b.name === 'WaitForUser') {
            const q =
              typeof b.input === 'object' && b.input !== null
                ? ((b.input as Record<string, unknown>).question as string | undefined)
                : undefined;
            if (!q) {
              // Still streaming the partial JSON; render nothing yet — the
              // streaming cursor on the prior text block carries the "typing"
              // signal until the full question arrives.
              return null;
            }
            return (
              <div
                key={i}
                className={clsx(
                  'text-[13px] text-text break-words',
                  isStreamingTail && i === message.content.length - 1 && 'after:content-["▍"] after:ml-0.5 after:text-accent after:animate-pulse'
                )}
              >
                <RichText text={q} />
              </div>
            );
          }
          return (
            <ToolCallCard
              key={i}
              toolUse={b}
              result={resultsById.get(b.id)}
              streaming={isStreamingTail && b.partialInput !== undefined}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

const MessageBlock = memo(MessageBlockImpl, messageBlockPropsEqual);

/**
 * Absolute timestamp rendered next to user / assistant messages.
 * Format: "Today 1:47 PM" / "May 21 1:47 PM" / "May 21, 2024 1:47 PM" — same
 * shape that's already used for tooltips elsewhere. Empty when no timestamp
 * is available (legacy imported messages without one).
 */
function MessageTimestamp({ ts }: { ts: number | null | undefined }) {
  if (!ts) return null;
  const abs = absoluteTime(ts);
  if (!abs) return null;
  return (
    <span
      className="text-[10px] text-text-dim font-mono cursor-default"
      title={new Date(ts).toISOString()}
    >
      {abs}
    </span>
  );
}
