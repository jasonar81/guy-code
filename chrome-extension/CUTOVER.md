# Chrome connector cutover plan

This is the staged plan for replacing the CDP-over-TCP Chrome
connector (which Chrome 136+ silently disables on default profiles)
with the extension-based connector. Nothing here is applied yet —
the running Guy Code instance still uses the old `chromeBridge.ts`.

**Apply all four steps in order, then restart the app.**

## Status

- New code is written and tested (32 new tests pass).
- New files in tree but inert:
  - `chrome-extension/` (manifest + service worker + popup; not loaded
    into Chrome until the user clicks Load Unpacked).
  - `electron/chromeWsServer.ts` (minimal WS server, no new deps).
  - `electron/chromeExtBridge.ts` (drop-in replacement for chromeBridge).
  - `tests/chromeWsServer.test.ts`, `tests/chromeExtBridge.test.ts`.
- The current `electron/chromeBridge.ts` is untouched. The renderer's
  `SettingsModal` still shows the old CDP launch command. Nothing in
  the running app has changed yet.

## Step 1 — Swap `electron/chromeBridge.ts` to re-export

Replace the entire contents of `electron/chromeBridge.ts` with:

```ts
/**
 * Chrome connector — re-export shim.
 *
 * The implementation lives in `chromeExtBridge.ts` (extension
 * transport over WebSocket). The original CDP-over-TCP version of
 * this file is preserved in git history; if Chrome ever fixes its
 * --remote-debugging-port behavior on default profiles, that's the
 * file to revert.
 *
 * Keeping the `chromeBridge` module path stable means `tools.ts`,
 * `ipc.ts`, and the test files don't need to change.
 */
export {
  getStatus,
  connect,
  disconnect,
  listTabs,
  openTab,
  extractTab,
  screenshotTab,
  waitForTab,
  clickTab,
  typeTab,
  pressTab,
  scrollTab,
  evalTab,
  DEFAULT_WS_PORT as DEFAULT_CDP_PORT,
} from './chromeExtBridge';
export type { ChromeStatus, TabInfo } from './chromeExtBridge';
```

Notes:
- `DEFAULT_CDP_PORT` is re-exported as an alias of `DEFAULT_WS_PORT`
  so any callers that imported it from the old module still resolve.
  The numeric value changes from 9222 → 9223 in the process; that's
  fine because the meaning changes too (it's no longer Chrome's debug
  port, it's our WS server port).
- The old `tests/chromeBridge.test.ts` will fail after this swap —
  it expects CDP-flavored error messages and `playwright-core`
  imports. Either delete it or rewrite it to point at the new
  bridge. Recommendation: delete; the new `chromeExtBridge.test.ts`
  has full coverage.

## Step 2 — Replace the SettingsModal Chrome connector section

In `src/components/SettingsModal.tsx`, replace the body of
`ChromeConnectorSection` (the `return (...)` block) with the
install-the-extension UI. The full replacement is at the end of
this file.

The key user-facing changes:
- No more "Copy this PowerShell command" step.
- Instead: "Install the Guy Code Bridge extension once" instructions
  with a "Open chrome://extensions/" button.
- Default port input value changes from `9222` to `9223`.
- Status pill works the same.

## Step 3 — Update `vite.config.ts`

Remove `playwright-core` from the `rollupOptions.external` lists for
both main and preload bundles (it's no longer imported by anything
in `electron/`). Search for two occurrences of `'playwright-core'`
and delete those lines.

Optionally, also remove `playwright-core` from `package.json`'s
`dependencies` and run `npm install` to drop ~50 MB from
`node_modules`. Do this only after confirming the new bridge works
in production for a few days — keeping `playwright-core` installed
costs nothing at runtime.

## Step 4 — Restart and verify

1. Kill all Electron processes:
   ```powershell
   Get-Process electron -EA SilentlyContinue | Stop-Process -Force
   ```
2. Wait 1-2 seconds for OS cleanup.
3. `npm run dev`
4. Open Settings → Chrome connector. The new install instructions
   should appear.
5. In Chrome:
   - `chrome://extensions/`
   - Enable Developer mode (toggle, top-right).
   - Click "Load unpacked".
   - Select `c:\Users\jarnold\Downloads\guy-code\chrome-extension`.
   - The extension icon should appear in the toolbar.
6. Back in the app, click **Connect** in Settings.
7. Within a few seconds the pill should flip to "Connected · N tabs".

If the handshake times out:
- Open the extension's service worker DevTools: from
  `chrome://extensions/`, find Guy Code Bridge, click "Service
  worker" link. Look for `connecting to ws://127.0.0.1:9223` and
  any reconnect-loop messages.
- Confirm the app's WS server is listening: `Test-NetConnection
  127.0.0.1 -Port 9223` in PowerShell.

## Appendix — Full SettingsModal replacement

Replace the contents of the existing `ChromeConnectorSection`
function with this. Imports and helper hooks stay the same.

```tsx
function ChromeConnectorSection({ open }: { open: boolean }) {
  const [status, setStatus] = useState<{
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    port: number | null;
    error: string | null;
    connectedAt: number | null;
    tabCount: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // Default port 9223 — see chromeExtBridge.DEFAULT_WS_PORT.
  const [portInput, setPortInput] = useState<string>('9223');

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.chrome.status();
      setStatus(r);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [open, refresh]);

  const onConnect = async () => {
    setBusy(true);
    setErrMsg(null);
    try {
      const portNum = Number(portInput.trim());
      const port = Number.isFinite(portNum) && portNum > 0 ? portNum : 9223;
      const r = await window.api.chrome.connect(port);
      setStatus(r.status ?? null);
      if (!r.ok && r.error) setErrMsg(r.error);
    } finally {
      setBusy(false);
    }
  };
  const onDisconnect = async () => {
    setBusy(true);
    setErrMsg(null);
    try {
      const r = await window.api.chrome.disconnect();
      setStatus(r.status ?? null);
    } finally {
      setBusy(false);
    }
  };

  const onOpenExtensionsPage = () => {
    // chrome://extensions/ doesn't open from `window.open` (Chromium
    // blocks chrome:// from non-privileged origins). The best we can
    // do is tell the user to paste it.
    window.api.clipboard?.writeText?.('chrome://extensions/');
  };

  const s = status?.status ?? 'disconnected';
  let pillIcon: React.ReactNode;
  let pillLabel: string;
  let pillCls = 'text-text-dim';
  switch (s) {
    case 'connected':
      pillIcon = <CheckCircle2 size={12} className="text-state-success" />;
      pillLabel = `Connected · ${status?.tabCount ?? 0} tab${
        status?.tabCount === 1 ? '' : 's'
      }`;
      pillCls = 'text-state-success';
      break;
    case 'connecting':
      pillIcon = <Loader2 size={12} className="text-text-dim animate-spin" />;
      pillLabel = 'Waiting for extension…';
      break;
    case 'error':
      pillIcon = <AlertCircle size={12} className="text-state-error" />;
      pillLabel = 'Error';
      pillCls = 'text-state-error';
      break;
    default:
      pillIcon = <X size={12} className="text-text-dim" />;
      pillLabel = 'Disconnected';
      break;
  }

  return (
    <div className="pt-2 border-t border-border">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-text mb-1.5">
        <Globe size={14} className="text-text-dim" />
        Chrome connector
      </div>
      <p className="text-[11px] text-text-dim leading-snug mb-2">
        Drive your existing logged-in Chrome (Gmail, Slack, Outlook,
        etc.) from the agent via a small browser extension. One-time
        setup; the extension reconnects automatically afterwards.
      </p>
      <ol className="text-[11px] text-text-dim leading-snug mb-2 list-decimal pl-4 space-y-0.5">
        <li>
          Open <code className="font-mono">chrome://extensions/</code> in Chrome.
        </li>
        <li>Turn on Developer mode (top-right toggle).</li>
        <li>
          Click <strong>Load unpacked</strong> and pick the{' '}
          <code className="font-mono">chrome-extension</code> folder inside
          your Guy Code checkout.
        </li>
        <li>Come back here and click Connect.</li>
      </ol>
      <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-border bg-bg/40">
        <div className="shrink-0">{pillIcon}</div>
        <div className="flex-1 min-w-0">
          <div className={clsx('text-[12px] truncate', pillCls)}>{pillLabel}</div>
          {status?.error && (
            <div className="text-[10px] text-state-error truncate" title={status.error}>
              {status.error}
            </div>
          )}
        </div>
        <input
          type="text"
          className="w-16 text-[11px] px-1.5 py-0.5 border border-border rounded bg-bg text-text"
          value={portInput}
          onChange={(e) => setPortInput(e.target.value)}
          disabled={busy || s === 'connected'}
          title="WS port (default 9223)"
        />
        {s === 'connected' ? (
          <button
            onClick={onDisconnect}
            disabled={busy}
            className="text-[11px] px-2 py-0.5 rounded border border-border text-text-muted hover:text-text hover:border-border-strong"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={busy}
            className="text-[11px] px-2 py-0.5 rounded border border-state-success/50 text-state-success hover:bg-state-success/10"
          >
            Connect
          </button>
        )}
      </div>
      {errMsg && (
        <div className="text-[10px] text-state-error mt-1.5">{errMsg}</div>
      )}
    </div>
  );
}
```
