import { useApp } from '@/lib/store';
import { SessionPane } from './ProjectPane';

/**
 * Pre-mounts a pane for every session the user has opened in this run.
 * Switching only toggles the `visible` flag and `visibility: hidden` — no
 * unmount. This is the core of the sub-50ms switch promise.
 */
export function PanesContainer() {
  const sessions = useApp((s) => s.sessions);
  const opened = useApp((s) => s.openedSessions);
  const activeId = useApp((s) => s.activeSessionId);

  if (!activeId) {
    return (
      <div className="flex-1 h-full flex items-center justify-center text-text-dim">
        <div className="max-w-md text-center px-6">
          <h2 className="text-[15px] text-text mb-2 font-medium">Guy Code</h2>
          <p className="text-[12px] leading-relaxed">
            Pick a session from the sidebar to get started, or click{' '}
            <strong className="text-text">+ New session</strong> to begin a fresh
            one. Existing sessions are imported from{' '}
            <code className="font-mono">~/.claude/projects/</code> so you can
            browse and continue them; Guy tracks its own spend independently of
            anything you ran in Claude Code.
          </p>
        </div>
      </div>
    );
  }

  // Stable DOM order across sidebar sort changes.
  //
  // Why this matters: the sidebar gets `sessions` sorted by recent
  // activity (DESC ended_at/started_at). When ANY session ticks
  // forward — top-of-hour budget wake, usage event during a stream,
  // a turn_done — `refreshSessions()` fires and the array reorders
  // (the just-active session jumps to position 0). If we mapped the
  // panes in that same order, the JSX child order changes and React
  // reconciles by calling `insertBefore` on the keyed children to
  // match — which DETACHES and REATTACHES every absolute-positioned
  // session pane. Browsers reset `scrollTop` to 0 on detach. Inside
  // each pane, Virtuoso's scroller snaps to top. That's the
  // cross-session scroll-to-top bug: the user is on session A, B
  // wakes from sleeping-budget, B's row jumps up the activity sort,
  // A's pane gets reordered in the DOM, A's scroll resets.
  //
  // Fix: sort the panes by a stable, never-changing property (the
  // session id) so the DOM child order is fixed for the lifetime of
  // each opened session. The sidebar's visual order is unaffected —
  // it consumes `sessions` directly, not the panes container — so
  // sorting just the panes here doesn't change UX, only DOM stability.
  const openedSessions = sessions
    .filter((s) => opened.has(s.id))
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return (
    <div className="flex-1 h-full relative">
      {openedSessions.map((s) => (
        <div
          key={s.id}
          className="absolute inset-0"
          style={{ visibility: s.id === activeId ? 'visible' : 'hidden' }}
        >
          <SessionPane session={s} visible={s.id === activeId} />
        </div>
      ))}
    </div>
  );
}
