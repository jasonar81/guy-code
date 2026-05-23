import { useState } from 'react';
import clsx from 'clsx';
import { Archive, ArchiveRestore } from 'lucide-react';
import type { SessionRow } from '@/types';
import { useApp } from '@/lib/store';
import { formatUsdMicros, sessionDisplayTitle, relativeTime } from '@/lib/format';
import { StateGlyph } from './StateGlyph';
import { SessionContextMenu } from './SessionContextMenu';

interface Props {
  session: SessionRow;
  showCwd?: boolean;
}

/**
 * One session = one row. The user's primary unit of attention.
 * Compact; cost pills + state glyph + title; cwd shown only when toggled.
 */
export function SessionListRow({ session: s, showCwd = false }: Props) {
  const active = useApp((st) => st.activeSessionId === s.id);
  const setActive = useApp((st) => st.setActive);
  const archive = useApp((st) => st.archive);

  // Position of the open context menu in viewport coords (clientX/clientY
  // from the right-click). Null = menu closed. Rendered as a fixed-position
  // popover so it isn't clipped by the sidebar's overflow:auto container.
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const lastTs = s.ended_at ?? s.started_at;

  // We use a <div role="button"> here instead of a <button> because the
  // archive icon below also needs to be a real button. Nesting a <button>
  // inside a <button> is invalid HTML and causes unreliable click handling
  // across browsers (the inner button's onClick sometimes silently no-ops),
  // which is exactly the bug the user hit when archiving from the sidebar.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setActive(s.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setActive(s.id);
        }
      }}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => {
        if (e.button === 1 && confirm('Archive this session?')) archive(s.id, true);
      }}
      className={clsx(
        'group flex items-start gap-2 px-3 py-1.5 text-left row-hover w-full cursor-pointer',
        active ? 'bg-bg-hover' : 'hover:bg-bg-elevated',
        'border-l-2',
        active ? 'border-accent' : 'border-transparent'
      )}
      title={s.cwd ?? undefined}
    >
      <span className="mt-1">
        <StateGlyph state={s.state} />
      </span>
      {s.emoji && <span className="text-[13px] leading-none mt-1">{s.emoji}</span>}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] truncate text-text">{sessionDisplayTitle(s)}</div>
        {showCwd && s.cwd && (
          <div className="text-[10px] text-text-dim truncate font-mono">{s.cwd}</div>
        )}
        {!showCwd && lastTs && (
          <div className="text-[10px] text-text-dim font-mono">
            {relativeTime(lastTs)} ago · {s.message_count} msgs
          </div>
        )}
      </div>
      {(s.cost_all_time_micros > 0 || s.cost_24h_micros > 0) && (
        <div className="flex flex-col items-end gap-0.5 shrink-0 mt-0.5">
          <span
            className="text-[10px] text-text-muted font-mono leading-none"
            title="All-time spend in Guy"
          >
            {formatUsdMicros(s.cost_all_time_micros)}
          </span>
          {s.cost_24h_micros > 0 && (
            <span
              className={clsx(
                'text-[10px] font-mono leading-none',
                s.cost_24h_micros > 5_000_000 ? 'text-state-attention' : 'text-text-dim'
              )}
              title="Last 24h in Guy"
            >
              24h: {formatUsdMicros(s.cost_24h_micros)}
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        onPointerDown={(e) => {
          // Use onPointerDown rather than onClick so the action fires on the
          // very first input the user makes, even if a sibling element later
          // tries to swallow the click event. We also stopPropagation here
          // so the row's setActive handler doesn't run after archive.
          e.stopPropagation();
          e.preventDefault();
          archive(s.id, !s.archived).catch((err) => {
            console.error('[archive] failed', { id: s.id, archived: !s.archived, err });
            alert('Archive failed — see DevTools console for details.');
          });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            archive(s.id, !s.archived).catch((err) => {
              console.error('[archive] failed', { id: s.id, archived: !s.archived, err });
            });
          }
        }}
        className="shrink-0 ml-1 mt-0.5 opacity-0 group-hover:opacity-100 text-text-dim hover:text-text transition-opacity rounded p-0.5 hover:bg-bg-hover cursor-pointer"
        title={s.archived ? 'Unarchive session' : 'Archive session'}
        aria-label={s.archived ? 'Unarchive session' : 'Archive session'}
      >
        {/* pointer-events:none on the icon ensures the click target is always
            the button itself, never the SVG/path inside. This eliminates any
            Lucide-icon-internal event quirks. */}
        <span style={{ pointerEvents: 'none' }}>
          {s.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
        </span>
      </button>
      {menuPos && (
        <SessionContextMenu
          session={s}
          x={menuPos.x}
          y={menuPos.y}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}
