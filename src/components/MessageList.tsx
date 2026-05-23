import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import clsx from 'clsx';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useApp } from '@/lib/store';
import { ToolCallCard } from './ToolCallCard';
import { RichText } from './RichText';
import { LinkifyText } from './LinkifyText';
import { absoluteTime } from '@/lib/format';
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

  // followOutput tells Virtuoso how to behave when the data array
  // grows: 'auto' = jump to bottom; false = leave the user where they
  // are. We use 'auto' (not 'smooth') because smooth scrolling lags
  // behind rapid text_delta updates and produces the "catches up
  // late" feeling the user reported. The boolean arg is Virtuoso's
  // own atBottom signal, more accurate than our state in the moment
  // of the data change.
  const followOutput = useCallback(
    (isAtBottom: boolean): false | 'smooth' | 'auto' => {
      return isAtBottom ? 'auto' : false;
    },
    []
  );

  const onAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
  }, []);

  // Tracks the previous `visible` flag across renders so we can detect
  // false→true transitions (session switch arriving at this pane).
  const wasVisibleRef = useRef(false);
  // Tracks the previous items count so we can detect empty→populated
  // transitions (history loaded async after the visible flip). Both of
  // these conditions force a scroll-to-bottom; nothing else does.
  const prevItemCountRef = useRef(0);

  /**
   * Fire scrollToIndex(LAST, 'end') across `frames` consecutive rAFs.
   *
   * Why retry across multiple frames? Virtuoso uses ResizeObserver and
   * IntersectionObserver to measure item heights. The first paint
   * after a visibility flip or an empty→populated transition often
   * happens BEFORE measurement has settled — if we ask Virtuoso to
   * scroll to the last item with `align:'end'` at that moment, the
   * offset math uses default item heights and may clamp scrollTop=0
   * (i.e. the visual top). Firing on multiple consecutive frames
   * guarantees that at least one of them lands AFTER measurement
   * settles. 8-12 frames (~133-200ms at 60fps, longer if the renderer
   * is busy) is generous enough for the worst tall-image / heavy-
   * markdown case we've actually observed, and short enough that the
   * user can still cancel by scrolling up immediately.
   *
   * Each tick reads the FRESHEST items length (via the items.length
   * dep on the closure) so a streaming delta arriving mid-retry
   * targets the new last index, not a stale one.
   *
   * Returns a cleanup function the caller can run in a useEffect
   * cleanup to cancel the in-flight retry.
   */
  const fireScrollToBottom = useCallback((frames = 8) => {
    let raf = 0;
    let left = frames;
    const tick = () => {
      const lastIndex = items.length - 1;
      if (lastIndex < 0) return;
      virtuosoRef.current?.scrollToIndex({
        index: lastIndex,
        align: 'end',
        behavior: 'auto',
      });
      left--;
      if (left > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items.length]);

  /**
   * Mount / visibility / history-loaded scroll-to-bottom effect.
   *
   * Fires on:
   *  (1) Pane just became visible (false→true). Session switch landed
   *      here; user expects newest material in view.
   *  (2) Items just transitioned from 0 to N while already visible.
   *      History loaded async after the visible flip — common on
   *      first-open of a session whose JSONL hadn't been read yet.
   *
   * Does NOT fire during in-session streaming or when items grow by 1+
   * during normal use — those are handled by the keep-up effect below,
   * which respects atBottomRef so a deliberate scroll-up survives.
   */
  useEffect(() => {
    const prevCount = prevItemCountRef.current;
    prevItemCountRef.current = items.length;
    if (!visible) {
      wasVisibleRef.current = false;
      return;
    }
    const justBecameVisible = !wasVisibleRef.current;
    wasVisibleRef.current = true;
    if (items.length === 0) return;
    const transitionedFromEmpty = prevCount === 0 && items.length > 0;
    if (!justBecameVisible && !transitionedFromEmpty) return;
    return fireScrollToBottom(12);
  }, [visible, items.length, fireScrollToBottom]);

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
   */
  useEffect(() => {
    if (!streaming) return;
    if (!atBottomRef.current) return;
    if (items.length === 0) return;
    return fireScrollToBottom(4);
  }, [items, streaming, fireScrollToBottom]);

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

  // Empty state: don't render Virtuoso at all (it would still mount
  // a viewport / scroller). A simple centered placeholder is cheaper
  // and matches the previous UX.
  if (items.length === 0) {
    return (
      <div className="flex-1 overflow-hidden flex items-center justify-center text-text-dim text-[12px]">
        Type a message below to start.
      </div>
    );
  }

  return (
    <Virtuoso<VirtItem>
      ref={virtuosoRef}
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
      className="flex-1 select-text"
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
          return (
            <div
              key={i}
              className={clsx(
                'text-[13px] text-text break-words',
                isStreamingTail && i === message.content.length - 1 && 'after:content-["▍"] after:ml-0.5 after:text-accent after:animate-pulse'
              )}
            >
              <RichText text={b.text} />
            </div>
          );
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
