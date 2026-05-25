import { useEffect, useState } from 'react';
import { Download, RefreshCw, AlertTriangle, X } from 'lucide-react';
import type { UpdateState } from '@/types';

/**
 * Top-of-window banner that surfaces auto-updater state to the user.
 *
 * State machine (mirrors `electron/autoUpdater.ts` `UpdateState`):
 *
 *   • idle / disabled  → render nothing.
 *   • checking         → render nothing (silent — most checks find
 *                        no update; surfacing every check would be
 *                        noisy).
 *   • available        → render nothing (download is in progress
 *                        in the background; user doesn't need to
 *                        do anything yet).
 *   • downloading      → small bar with progress percentage.
 *                        Non-blocking; user can keep working.
 *   • downloaded       → banner with "Restart to install" button.
 *                        Clicking calls `update:install` which
 *                        first quiesces in-flight turns, then
 *                        triggers `quitAndInstall`.
 *   • error            → small dismissable warning (only after a
 *                        manual check; we don't show errors from
 *                        background polling — those appear in the
 *                        log file for diagnostics).
 *
 * The banner subscribes to `update:event` for live updates and
 * fetches `update:status` once on mount to catch any state that
 * fired before React was ready (e.g., update was already
 * downloaded when the user opened the app).
 */

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [errorDismissed, setErrorDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Initial snapshot — captures any state that arrived before
    // the listener was bound (download finished while the app
    // was loading, etc.).
    window.api.update
      .status()
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        // No-op: update IPC missing means we're in an older preload
        // build or the handler isn't registered yet. Banner just
        // stays hidden.
      });
    const unsub = window.api.update.onEvent((s) => {
      if (!cancelled) {
        setState(s);
        // Reset the dismissed flag when state changes so re-arming
        // an error after dismiss-then-error still surfaces it.
        if (s.state !== 'error') setErrorDismissed(false);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (!state) return null;
  if (state.state === 'idle' || state.state === 'disabled') return null;
  if (state.state === 'checking' || state.state === 'available') return null;

  const onInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const r = await window.api.update.install();
      if (!r.ok) {
        setInstallError(r.error ?? 'install failed');
      }
      // On success we never get here — quitAndInstall terminates
      // the process. The renderer is gone.
    } catch (e: any) {
      setInstallError(e?.message ?? String(e));
    } finally {
      setInstalling(false);
    }
  };

  if (state.state === 'downloaded') {
    return (
      <div className="px-3 py-1.5 bg-state-attention/10 border-b border-state-attention/40 flex items-center gap-3 text-[13px]">
        <Download size={14} className="text-state-attention" />
        <span className="flex-1">
          Update <strong>{state.availableVersion}</strong> ready (current{' '}
          {state.currentVersion}).
          {installError && (
            <span className="ml-2 text-state-error">{installError}</span>
          )}
        </span>
        <button
          onClick={onInstall}
          disabled={installing}
          className="px-3 py-1 rounded-md bg-state-attention/20 hover:bg-state-attention/30 border border-state-attention/40 text-state-attention disabled:opacity-50 disabled:cursor-wait text-[12px] font-medium inline-flex items-center gap-1.5"
          title="Drains in-flight conversations, then restarts into the new version. May take up to 30 s if a tool call is running."
        >
          {installing ? (
            <>
              <RefreshCw size={12} className="animate-spin" />
              Draining…
            </>
          ) : (
            <>
              <RefreshCw size={12} />
              Restart to install
            </>
          )}
        </button>
      </div>
    );
  }

  if (state.state === 'downloading') {
    return (
      <div className="px-3 py-1 bg-bg-elevated/60 border-b border-border flex items-center gap-3 text-[12px] text-text-muted">
        <Download size={12} />
        <span className="flex-1">
          Downloading update {state.availableVersion ?? ''} —{' '}
          {state.downloadPercent}%
        </span>
        <div className="w-32 h-1.5 bg-bg rounded-full overflow-hidden">
          <div
            className="h-full bg-state-attention transition-all"
            style={{ width: `${state.downloadPercent}%` }}
          />
        </div>
      </div>
    );
  }

  if (state.state === 'error' && !errorDismissed && state.error) {
    // Only show errors after a manual check or download — we don't
    // want background-poll failures (network blip, GitHub rate
    // limit) flashing a banner. The check is implicit: if the
    // banner is visible and state.error is set, we surface it.
    // Background errors do log to the file for diagnosis.
    return (
      <div className="px-3 py-1.5 bg-state-error/10 border-b border-state-error/40 flex items-center gap-3 text-[12px] text-state-error">
        <AlertTriangle size={14} />
        <span className="flex-1">Update check failed: {state.error}</span>
        <button
          onClick={() => setErrorDismissed(true)}
          className="p-0.5 rounded hover:bg-state-error/20"
          title="Dismiss"
          aria-label="Dismiss update error"
        >
          <X size={12} />
        </button>
      </div>
    );
  }

  return null;
}
