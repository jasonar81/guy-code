import { useEffect } from 'react';
import {
  formatUsdMicros,
  sessionDisplayTitle,
} from '@/lib/format';
import { StateGlyph } from './StateGlyph';
import type { SessionRow } from '@/types';
import { FolderOpen } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Composer } from './Composer';
import { CurrentPlanPanel } from './CurrentPlanPanel';
import { MessageList } from './MessageList';

interface Props {
  session: SessionRow;
  visible: boolean;
}

/**
 * Mounted but possibly hidden — keeps DOM warm for instant switching.
 * Hidden via the `hidden` attribute (display:none), so React never unmounts.
 */
export function SessionPane({ session, visible }: Props) {
  const loadHistory = useApp((s) => s.loadHistory);

  // Lazy-load message history the first time this pane is opened.
  useEffect(() => {
    if (!visible) return;
    loadHistory(session.id, session.jsonl_path);
  }, [visible, session.id, session.jsonl_path, loadHistory]);

  return (
    <div hidden={!visible} className="h-full flex flex-col bg-bg">
      <header className="px-5 py-3 border-b border-border flex items-center gap-3">
        <StateGlyph state={session.state} />
        {session.emoji && <span className="text-base leading-none">{session.emoji}</span>}
        <div className="flex-1 min-w-0">
          <div className="text-[14px] text-text font-medium truncate">
            {sessionDisplayTitle(session)}
          </div>
          {session.cwd && (
            <div className="text-[11px] text-text-dim font-mono truncate">
              <FolderOpen size={11} className="inline -mt-0.5 mr-1" />
              {session.cwd}
            </div>
          )}
        </div>
        <div
          className="flex flex-col items-end gap-0.5 shrink-0 text-[11px] font-mono"
          title="Spend in Guy (excludes Claude Code history)"
        >
          <span className="text-text-muted">
            All-time {formatUsdMicros(session.cost_all_time_micros)}
          </span>
          <span className="text-text-dim">
            24h {formatUsdMicros(session.cost_24h_micros)}
          </span>
        </div>
      </header>

      <CurrentPlanPanel sessionId={session.id} />
      <MessageList sessionId={session.id} visible={visible} />
      <Composer sessionId={session.id} visible={visible} />
    </div>
  );
}
