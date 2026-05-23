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

  const openedSessions = sessions.filter((s) => opened.has(s.id));

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
