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

    // PERF: the model streams one `text_delta` IPC message PER TOKEN, and each
    // one used to drive a full store update: copy the messages array, clone the
    // tail message, rebuild its content, build a new chats object, re-render.
    // On a long reply that's thousands of O(messages) updates, which is why the
    // whole app (typing, clicking, scrolling) locked up while the open session
    // was streaming.
    //
    // Coalesce instead: buffer consecutive text deltas per session and flush
    // them as ONE combined delta on the next animation frame. The text is
    // identical - it just arrives in frame-sized chunks (60/s at most) instead
    // of token-sized ones. Any non-delta event flushes the buffer first so
    // ordering is preserved exactly.
    const pending = new Map<string, string>();
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (pending.size === 0) return;
      for (const [sessionId, text] of pending) {
        applyAgentEvent({ type: 'text_delta', sessionId, text } as never);
      }
      pending.clear();
    };
    const scheduleFlush = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const offAgent = window.api.agent.onEvent((e: any) => {
      if (e?.type === 'text_delta' && typeof e.text === 'string' && e.sessionId) {
        pending.set(e.sessionId, (pending.get(e.sessionId) ?? '') + e.text);
        scheduleFlush();
        return;
      }
      // Preserve ordering: anything else must land after the buffered text.
      if (pending.size) flush();
      applyAgentEvent(e);
    });

    // Safety-net refresh for anything the event stream can't tell us about
    // (changes made in another window, or by the Slack remote control). Agent
    // events already refresh on the transitions that matter, so this is only a
    // backstop - it was every 5s, which meant a full session-list query + IPC
    // of every row twelve times a minute for no reason.
    const interval = setInterval(() => refresh(), 60_000);

    return () => {
      offImport();
      offAgent();
      if (raf) cancelAnimationFrame(raf);
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
