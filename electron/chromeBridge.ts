/**
 * Chrome connector — re-export shim.
 *
 * The real implementation now lives in `chromeExtBridge.ts`: a small
 * WebSocket server in the Electron main process plus a Chrome
 * extension service worker that connects to it and runs DOM
 * automation via `chrome.tabs.*` and `chrome.scripting.*`.
 *
 * This file used to be the CDP-over-TCP implementation
 * (`playwright-core` + `chromium.connectOverCDP`). Chrome 136+ silently
 * disables `--remote-debugging-port` on default signed-in profiles
 * as an anti-cookie-theft measure, which made the old approach
 * unusable for the primary use case (driving the user's real,
 * already-signed-in Chrome). The CDP file is preserved in git
 * history — if Google ever fixes that behavior, that's the file to
 * revert.
 *
 * Why keep the `chromeBridge` module path:
 *   `electron/tools.ts` reaches in via `await import('./chromeBridge')`
 *   from every Browser* tool, and `electron/ipc.ts` does the same from
 *   the `chrome:status` / `chrome:connect` / `chrome:disconnect`
 *   handlers. Re-exporting from this file keeps those import strings
 *   stable, so the swap is a single-file edit.
 *
 * Why `DEFAULT_CDP_PORT` is re-exported as an alias of
 * `DEFAULT_WS_PORT`:
 *   Some older callers (and tests of those callers) still import the
 *   old constant name. The numeric value changes from 9222 → 9223 in
 *   the swap; that's fine, because the meaning changed too. It's no
 *   longer Chrome's debug port — it's our WebSocket server port.
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
  authorizeTab,
  DEFAULT_WS_PORT as DEFAULT_CDP_PORT,
} from './chromeExtBridge';
export type {
  ChromeStatus,
  TabInfo,
  ScreenshotLabel,
  ScreenshotResult,
} from './chromeExtBridge';
