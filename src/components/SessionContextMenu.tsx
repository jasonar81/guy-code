import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Edit3,
  Archive,
  ArchiveRestore,
  Trash2,
  X,
  KeyRound,
  Check,
  Star,
  Moon,
} from 'lucide-react';
import type { SessionRow } from '@/types';
import { useApp } from '@/lib/store';
import { sessionDisplayTitle } from '@/lib/format';

interface Props {
  session: SessionRow;
  /** Viewport x coord where the user right-clicked. */
  x: number;
  /** Viewport y coord where the user right-clicked. */
  y: number;
  onClose: () => void;
}

/**
 * Right-click context menu for a session row in the sidebar. Renders
 * via portal at fixed coordinates (not absolute-positioned inside the
 * row) so the sidebar's `overflow-y: auto` doesn't clip it. Closes on:
 *
 *   - any click outside (capture-phase mousedown listener)
 *   - Escape
 *   - selecting an action
 *
 * Actions:
 *   - **Rename** — inline-edit mode: row stays where it is, an input
 *     replaces the title. Enter to save, Esc to cancel. Calls
 *     `store.rename` which updates the user_title column and refreshes
 *     the session list.
 *   - **Archive / Unarchive** — toggles `archived`. Same action as the
 *     hover-revealed icon on the row, just discoverable from the menu.
 *   - **Delete from disk** — destructive. Removes the JSONL files
 *     (Guy copy + original) AND the DB row. Triple-confirm with a
 *     window.confirm so it's hard to fire accidentally.
 *
 * Why a separate component (instead of inlining into ProjectRow): the
 * menu needs to render via portal to escape the sidebar's clip rect,
 * which means its DOM doesn't share the row's React parent. Splitting
 * keeps the row's render simple and means we can also reuse this menu
 * elsewhere in the future (e.g. a session header dropdown).
 */
export function SessionContextMenu({ session: s, x, y, onClose }: Props) {
  const rename = useApp((st) => st.rename);
  const archive = useApp((st) => st.archive);
  const deleteFromDisk = useApp((st) => st.deleteFromDisk);
  const markIdle = useApp((st) => st.markIdle);
  const apiKeys = useApp((st) => st.apiKeys);
  const setSessionApiKey = useApp((st) => st.setSessionApiKey);

  // Inline rename mode lives inside the menu — when active, we swap
  // the menu items for an input field. This avoids window.prompt's
  // blocking modal feel (the old behavior the user complained about).
  const [renaming, setRenaming] = useState(false);
  // Sub-mode: picking a different API key for this session. Like
  // renaming, this swaps the menu items for a list view instead of
  // opening a separate sub-menu — keeps the portal positioning logic
  // simple and matches the rename UX.
  const [pickingKey, setPickingKey] = useState(false);
  const [draft, setDraft] = useState<string>(
    s.user_title ?? sessionDisplayTitle(s)
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Auto-focus the input when entering rename mode so the user can
  // start typing immediately.
  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  // Close on outside-click and Escape. We listen in capture phase so
  // we beat any inner-element handlers; that way the menu closes even
  // if the user right-clicks ANOTHER row (the new right-click closes
  // this menu before the new one opens).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Clamp the menu position to the viewport so it doesn't render
  // off-screen when the user right-clicks near the bottom or right
  // edge of the window. The picker mode's height varies with key count;
  // we cap it at 240px and let the inner list scroll.
  const MENU_W = 240;
  const MENU_H = renaming
    ? 96
    : pickingKey
      ? Math.min(240, 64 + apiKeys.length * 36)
      : 200;
  const clampedX = Math.min(x, window.innerWidth - MENU_W - 8);
  const clampedY = Math.min(y, window.innerHeight - MENU_H - 8);

  const doRename = () => {
    const next = draft.trim();
    rename(s.id, next.length > 0 ? next : null).catch((err) => {
      console.error('[rename] failed', err);
      alert('Rename failed — see DevTools console for details.');
    });
    onClose();
  };

  const doArchive = () => {
    archive(s.id, !s.archived).catch((err) => {
      console.error('[archive] failed', err);
      alert('Archive failed — see DevTools console for details.');
    });
    onClose();
  };

  // Manual override: move a session to `idle` without archiving it. The
  // runtime parks finished sessions in `waiting-on-user` so the user can
  // see they need attention; this lets the user say "no, I'm done with
  // this for now, stop nagging me" without losing the session entirely.
  const doMarkIdle = () => {
    markIdle(s.id).catch((err) => {
      console.error('[markIdle] failed', err);
      alert('Move to idle failed — see DevTools console for details.');
    });
    onClose();
  };

  const doSetApiKey = async (apiKeyId: string | null) => {
    try {
      await setSessionApiKey(s.id, apiKeyId);
    } catch (err) {
      console.error('[setSessionApiKey] failed', err);
      alert('Setting API key failed — see DevTools console for details.');
    }
    onClose();
  };

  const doDelete = () => {
    const title = sessionDisplayTitle(s);
    // Triple-confirm: this is destructive and irreversible. The two
    // prompts are deliberately phrased differently so muscle memory
    // doesn't carry the user past both.
    const ok1 = window.confirm(
      `Permanently delete this session?\n\n"${title}"\n\nThis removes the JSONL file from disk AND the database row. The session will not come back even after a re-import scan.`
    );
    if (!ok1) return;
    const ok2 = window.confirm(
      `Last chance. Delete "${title}" from disk?`
    );
    if (!ok2) return;
    deleteFromDisk(s.id).catch((err) => {
      console.error('[deleteFromDisk] failed', err);
      alert(
        `Delete failed: ${err?.message ?? String(err)}\n\nSee DevTools console for details.`
      );
    });
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Session actions"
      // Stop right-clicks from re-firing the row's onContextMenu (which
      // would re-open the menu at a new position while this one is
      // still open).
      onContextMenu={(e) => e.preventDefault()}
      // Block click bubbling to the row (which would call setActive and
      // switch to this session unexpectedly).
      onClick={(e) => e.stopPropagation()}
      // Block KEYBOARD bubbling too. React synthetic events bubble
      // through the React tree, not the DOM tree, so even though the
      // menu is portaled to document.body, key events still bubble up
      // to ProjectRow's <div role="button"> parent in React land. That
      // div treats Space (and Enter) as "activate the row" — which
      // swallows the space character when the user tries to type a
      // multi-word name in the rename input. stopPropagation here
      // keeps all key events scoped to the menu.
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: clampedX,
        top: clampedY,
        width: MENU_W,
        zIndex: 1000,
      }}
      className="rounded-md border border-border bg-bg-panel shadow-lg py-1 text-[12px] text-text"
    >
      {renaming ? (
        <div className="px-2 py-1.5 space-y-1.5">
          <div className="text-[10px] text-text-dim font-mono uppercase tracking-wider">
            Rename session
          </div>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                doRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Leave blank to clear custom name"
            className="w-full bg-bg-elevated border border-border rounded px-1.5 py-1 text-[12px] text-text focus:outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={onClose}
              className="px-2 py-0.5 text-[11px] text-text-muted hover:text-text rounded hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={doRename}
              className="px-2 py-0.5 text-[11px] text-bg bg-accent hover:bg-accent/90 rounded"
            >
              Save
            </button>
          </div>
        </div>
      ) : pickingKey ? (
        <div className="py-1">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-text-dim font-mono">
            Use API key
          </div>
          {apiKeys.length === 0 && (
            <div className="px-2 py-1.5 text-[11px] text-text-dim italic">
              No API keys configured. Add one in Settings.
            </div>
          )}
          {apiKeys.map((k) => {
            const isCurrent = (s.api_key_id ?? null) === k.id;
            return (
              <button
                key={k.id}
                onClick={() => doSetApiKey(k.id)}
                role="menuitem"
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-bg-hover"
              >
                <span className="shrink-0 w-3 flex justify-center">
                  {isCurrent ? (
                    <Check size={11} className="text-state-success" />
                  ) : null}
                </span>
                <span className="flex-1 min-w-0 text-text truncate">
                  {k.name}
                  {k.is_default && (
                    <Star
                      size={9}
                      className="inline -mt-0.5 ml-1 text-state-attention"
                      fill="currentColor"
                      aria-label="default"
                    />
                  )}
                </span>
                {k.preview && (
                  <span className="text-[10px] font-mono text-text-dim shrink-0">
                    {k.preview}
                  </span>
                )}
              </button>
            );
          })}
          {apiKeys.length > 0 && (
            <>
              <div className="my-1 border-t border-border" />
              {/* "Inherit default" lets the user clear an explicit binding
                  so the session follows whichever key is currently the
                  default. Useful when they previously pinned to a key
                  and want to revert to "just use whatever I'm using". */}
              <button
                onClick={() => doSetApiKey(null)}
                role="menuitem"
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-bg-hover text-text-muted"
                title="Clear this session's explicit binding so it follows whichever key is the current default"
              >
                <span className="shrink-0 w-3 flex justify-center">
                  {s.api_key_id == null ? (
                    <Check size={11} className="text-state-success" />
                  ) : null}
                </span>
                <span className="flex-1">Inherit default</span>
              </button>
            </>
          )}
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={<X size={12} />}
            label="Back"
            onClick={() => setPickingKey(false)}
            muted
          />
        </div>
      ) : (
        <>
          <MenuItem
            icon={<Edit3 size={12} />}
            label="Rename"
            onClick={() => setRenaming(true)}
          />
          <MenuItem
            icon={<KeyRound size={12} />}
            label="Change API key…"
            onClick={() => setPickingKey(true)}
          />
          {s.state !== 'idle' && !s.archived && (
            <MenuItem
              icon={<Moon size={12} />}
              label="Move to idle"
              onClick={doMarkIdle}
            />
          )}
          <MenuItem
            icon={s.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
            label={s.archived ? 'Unarchive' : 'Archive'}
            onClick={doArchive}
          />
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={<Trash2 size={12} />}
            label="Delete from disk…"
            onClick={doDelete}
            destructive
          />
          <div className="my-1 border-t border-border" />
          <MenuItem
            icon={<X size={12} />}
            label="Cancel"
            onClick={onClose}
            muted
          />
        </>
      )}
    </div>,
    document.body
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  destructive,
  muted,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={
        'w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-bg-hover ' +
        (destructive
          ? 'text-state-error hover:text-state-error'
          : muted
            ? 'text-text-dim'
            : 'text-text')
      }
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}
