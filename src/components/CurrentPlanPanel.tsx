import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { useApp } from '@/lib/store';

interface Props {
  sessionId: string;
}

/**
 * Sticky panel above the message transcript that surfaces the most
 * recent TodoWrite plan.
 *
 * Why this exists: the model often emits a single sentence between
 * long tool calls ("Save baseline 1M sameprefix and continue."), giving
 * the user no view of how the current step fits the larger goal.
 * Scrolling backward through hundreds of messages to find the last plan
 * is expensive both for the user (cognitive) and the renderer (DOM).
 *
 * The panel reads `chat.currentTodos` from the store, which the reducer
 * keeps in sync incrementally:
 *   - On `tool_use_done` for TodoWrite (live updates mid-turn).
 *   - On `loadHistory` via `findLatestTodos` (reseeded on session
 *     switch and app restart).
 *
 * Renders nothing if the model hasn't issued a TodoWrite yet — we
 * deliberately don't show "(no plan)" because that creates dead space
 * in fresh sessions where there's nothing to plan.
 */
export function CurrentPlanPanel({ sessionId }: Props) {
  const todos = useApp((s) => s.chats[sessionId]?.currentTodos ?? null);
  const [collapsed, setCollapsed] = useState(false);

  if (!todos || todos.length === 0) return null;

  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const inProgress = todos.find((t) => t.status === 'in_progress');

  return (
    <div className="border-b border-border bg-bg-panel/60 backdrop-blur-sm">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-bg-hover/40"
        title={
          collapsed
            ? 'Expand current plan'
            : 'Collapse current plan (saves vertical space)'
        }
      >
        {collapsed ? (
          <ChevronRight size={12} className="text-text-dim shrink-0" />
        ) : (
          <ChevronDown size={12} className="text-text-dim shrink-0" />
        )}
        <ListChecks size={12} className="text-accent shrink-0" />
        <span className="text-[11px] font-mono uppercase tracking-wider text-text-muted shrink-0">
          plan
        </span>
        <span className="text-[12px] text-text-dim font-mono shrink-0">
          {done}/{total}
        </span>
        {inProgress && (
          <span
            className="text-[12px] text-text truncate flex-1 italic"
            title={inProgress.content}
          >
            → {inProgress.content}
          </span>
        )}
      </button>
      {!collapsed && (
        // Cap the plan list at ~30% of the viewport and scroll past that.
        // Without this cap a long plan (or items with long content) grows
        // the panel to its full content height, which on a tall plan can
        // shove the message transcript and the composer's input box off
        // screen — leaving the session unusable. The header above always
        // shows done/total + the in-progress step, so the at-a-glance state
        // survives even when the list is scrolled or collapsed.
        <ol className="px-4 pb-3 space-y-1 max-h-[30vh] overflow-y-auto">
          {todos.map((t) => (
            <li
              key={t.id}
              className={clsx(
                'flex items-start gap-2 text-[12px]',
                t.status === 'completed' && 'text-text-dim line-through',
                t.status === 'in_progress' && 'text-text font-medium',
                t.status === 'pending' && 'text-text-muted'
              )}
            >
              <span
                className={clsx(
                  'inline-block w-3 shrink-0 text-center text-[10px] mt-0.5',
                  t.status === 'completed' && 'text-state-running',
                  t.status === 'in_progress' && 'text-state-attention',
                  t.status === 'pending' && 'text-text-dim'
                )}
                aria-hidden
              >
                {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'}
              </span>
              <span className="break-words flex-1 select-text">{t.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
