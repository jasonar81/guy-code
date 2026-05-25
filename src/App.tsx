import { useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { PanesContainer } from './components/PanesContainer';
import { UpdateBanner } from './components/UpdateBanner';
import { useApp } from './lib/store';

export default function App() {
  const refresh = useApp((s) => s.refreshSessions);
  const setImportProgress = useApp((s) => s.setImportProgress);
  const applyAgentEvent = useApp((s) => s.applyAgentEvent);
  const refreshHasApiKey = useApp((s) => s.refreshHasApiKey);
  const refreshApiKeys = useApp((s) => s.refreshApiKeys);

  useEffect(() => {
    refresh();
    refreshHasApiKey();
    refreshApiKeys();
    const offImport = window.api.imports.onProgress((p) => setImportProgress(p));
    const offAgent = window.api.agent.onEvent((e) => applyAgentEvent(e));
    const interval = setInterval(() => refresh(), 5000);
    return () => {
      offImport();
      offAgent();
      clearInterval(interval);
    };
  }, [refresh, setImportProgress, applyAgentEvent, refreshHasApiKey, refreshApiKeys]);

  // Keyboard shortcuts: Ctrl+1..9 (jump to nth visible session),
  // Ctrl+Shift+N cycles "Needs you" sessions.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const sessions = useApp.getState().sessions;
      const setActive = useApp.getState().setActive;

      if (e.key >= '1' && e.key <= '9' && !e.shiftKey) {
        const idx = Number(e.key) - 1;
        const s = sessions[idx];
        if (s) {
          setActive(s.id);
          e.preventDefault();
        }
      } else if (e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        const NEEDS = new Set(['waiting-on-user', 'error']);
        const needs = sessions.filter((s) => NEEDS.has(s.state));
        if (needs.length === 0) return;
        const cur = useApp.getState().activeSessionId;
        const i = needs.findIndex((s) => s.id === cur);
        const next = needs[(i + 1) % needs.length];
        setActive(next.id);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-text overflow-hidden">
      <UpdateBanner />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar />
        <PanesContainer />
      </div>
    </div>
  );
}
