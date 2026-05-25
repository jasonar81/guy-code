/**
 * Auto-update wiring for the packaged app.
 *
 * Uses `electron-updater` to poll GitHub Releases for new versions of
 * `jasonar81/guy-code` and download them in the background. The user
 * sees a banner in the renderer (UpdateBanner.tsx) when an update has
 * downloaded; clicking "Restart" triggers `quitAndInstall`.
 *
 * Boot-time behavior:
 *   • Dev (`!app.isPackaged`): no-op. electron-updater throws when
 *     run from a sources tree because there's no valid update
 *     manifest near the executable. Calling its API in dev would
 *     spam logs with errors. The renderer's update banner just
 *     never fires.
 *   • Packaged: kick off `checkForUpdates` immediately, then every
 *     `CHECK_INTERVAL_MS` thereafter. autoDownload=true so a found
 *     update streams down without prompting; user only sees the
 *     "ready to restart" banner.
 *
 * IPC surface (see `ipc.ts` `update:*` handlers and `preload.ts`):
 *   • `update:status`          — current { state, version, error }.
 *   • `update:check`           — force a manual check (Settings has a
 *     "Check for updates" button that calls this).
 *   • `update:install`         — `quitAndInstall` once an update has
 *     finished downloading. Renderer's UpdateBanner is the only
 *     caller; this isn't auto-fired.
 *   • broadcast `update:event` — every state transition (checking,
 *     available, not-available, downloading, downloaded, error).
 *     Renderer subscribes via preload bridge; lets the banner
 *     update without polling.
 *
 * Settings keys read at startup:
 *   • `update.autoCheck`       — '1' (default) or '0'. When '0', we
 *     don't poll but still expose the manual `update:check` IPC.
 *
 * The actual quit-and-install dance is gated by the quiesce manager
 * (see `quiesceManager.ts`) so an in-flight agent turn isn't killed
 * mid-stream — when the user clicks Restart, we ask all sessions to
 * reach a quiescent state first, then call `quitAndInstall`.
 */

import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import { autoUpdater } from 'electron-updater';
import { getSetting } from './db';

/**
 * Poll interval after the initial check (ms). 4 hours matches the
 * GitHub Releases polling cadence other Electron apps use — balances
 * "noticeable lag from publishing to update prompt" with "not
 * hammering rate-limited GitHub APIs."
 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Initial check delay (ms). We don't fire immediately on app start
 * because the renderer hasn't mounted yet — the banner would have
 * nowhere to render. A short delay also gives the user a moment to
 * see their session list before any update notification kicks in.
 */
const INITIAL_CHECK_DELAY_MS = 30_000;

/**
 * UpdateState snapshot the renderer reads via IPC. Each transition
 * also goes out as a broadcast event so the renderer doesn't have
 * to poll.
 */
export interface UpdateState {
  /**
   * High-level state machine:
   *   • idle           — no check has fired yet, OR the most recent
   *                      check found we're already up to date.
   *   • checking       — a check is in flight.
   *   • available      — a newer version exists; download started.
   *   • downloading    — bytes are flowing.
   *   • downloaded     — fully downloaded; the user can install now.
   *   • error          — the most recent check or download failed.
   *                      `error` field has details. We re-poll on
   *                      the next interval, so transient failures
   *                      self-heal.
   *   • disabled       — running in dev (`!app.isPackaged`); the
   *                      whole subsystem is a no-op.
   */
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'disabled';
  /** Version string of the available update, if any. */
  availableVersion: string | null;
  /** Currently-installed version (always populated). */
  currentVersion: string;
  /** Last error message, if state === 'error'. */
  error: string | null;
  /** 0..100 percentage during 'downloading'. */
  downloadPercent: number;
  /** Epoch ms of the most recent check attempt (success OR failure). */
  lastCheckedAt: number | null;
}

let _state: UpdateState = {
  state: 'disabled',
  availableVersion: null,
  currentVersion: app.getVersion(),
  error: null,
  downloadPercent: 0,
  lastCheckedAt: null,
};

let _intervalTimer: NodeJS.Timeout | null = null;
let _getMainWindow: (() => BrowserWindow | null) | null = null;

function broadcast() {
  const w = _getMainWindow?.() ?? null;
  if (w && !w.isDestroyed()) {
    w.webContents.send('update:event', _state);
  }
}

function setState(patch: Partial<UpdateState>) {
  _state = { ..._state, ...patch };
  broadcast();
}

/**
 * Wire all electron-updater event listeners. Idempotent — calling
 * this twice would double-bind, so initAutoUpdater guards against
 * re-entry.
 */
function bindEventListeners() {
  // electron-updater's logger interface matches electron-log's,
  // so this routes its chatter into the same on-disk log file
  // the rest of the app uses. Helpful for diagnosing why a check
  // failed (404 release, signature mismatch, etc.).
  autoUpdater.logger = log;

  // Background download as soon as an update is found. The
  // 'downloaded' event then fires when bytes are on disk.
  autoUpdater.autoDownload = true;
  // Don't auto-install on quit. We want the user to click Restart
  // (after the quiesce manager confirms in-flight turns can drain).
  // Otherwise a background quit (cmd-Q during a stream) would kill
  // the agent loop and reboot into the new version mid-tool-call.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    setState({ state: 'checking', error: null, lastCheckedAt: Date.now() });
  });
  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] update available: ${info.version}`);
    setState({
      state: 'available',
      availableVersion: info.version,
      error: null,
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    log.info(`[updater] up to date (latest ${info.version})`);
    setState({
      state: 'idle',
      availableVersion: null,
      error: null,
    });
  });
  autoUpdater.on('error', (err) => {
    const msg = err?.message ?? String(err);
    log.warn(`[updater] error: ${msg}`);
    setState({ state: 'error', error: msg });
  });
  autoUpdater.on('download-progress', (progress) => {
    setState({
      state: 'downloading',
      downloadPercent: Math.round(progress.percent ?? 0),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] downloaded ${info.version}; ready to install`);
    setState({
      state: 'downloaded',
      availableVersion: info.version,
      downloadPercent: 100,
      error: null,
    });
  });
}

/**
 * Initialize the auto-updater. Safe to call exactly once on app
 * ready. Pass a `getMainWindow` thunk so the broadcaster can find
 * the latest window even if the user's session swaps it out
 * (BrowserWindow lifecycle).
 */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null) {
  _getMainWindow = getMainWindow;
  // Always populate currentVersion so the IPC status query has
  // something useful even in dev mode.
  setState({ currentVersion: app.getVersion() });

  if (!app.isPackaged) {
    // In dev (npm run dev), running electron-updater is a guaranteed
    // ENOENT on its update-info file lookup. Skip cleanly so the
    // renderer's banner code can still mount without surfacing
    // confusing errors.
    log.info('[updater] disabled in dev mode (app.isPackaged === false)');
    setState({ state: 'disabled' });
    return;
  }

  bindEventListeners();

  const autoCheck = (getSetting('update.autoCheck') ?? '1').trim();
  if (autoCheck === '0') {
    // User opted out of automatic polling. Keep the IPC live so
    // they can still manually check from Settings.
    log.info('[updater] auto-check disabled via settings (update.autoCheck=0)');
    setState({ state: 'idle' });
    return;
  }

  // Initial check after a short delay (let the renderer mount).
  setTimeout(() => {
    checkForUpdates().catch((e) =>
      log.warn('[updater] initial check threw', e)
    );
  }, INITIAL_CHECK_DELAY_MS);

  // Periodic check thereafter.
  _intervalTimer = setInterval(() => {
    checkForUpdates().catch((e) =>
      log.warn('[updater] periodic check threw', e)
    );
  }, CHECK_INTERVAL_MS);
}

/**
 * Tear down. Called from `app.on('window-all-closed')` so the
 * interval doesn't keep the process alive after the last window
 * closes. Idempotent.
 */
export function shutdownAutoUpdater() {
  if (_intervalTimer) {
    clearInterval(_intervalTimer);
    _intervalTimer = null;
  }
}

/**
 * Trigger a one-shot check. The IPC handler `update:check` calls
 * this when the user clicks "Check for updates" in Settings, AND
 * it's also the engine for periodic polling.
 *
 * In dev or when the auto-check setting is off, this still fires
 * if explicitly invoked — the IPC route is a manual override.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) {
    // Manual check in dev: pretend we're up to date so the UI flow
    // is at least exercisable. The actual check would throw.
    setState({
      state: 'idle',
      error: 'auto-update is disabled in dev (app not packaged)',
      lastCheckedAt: Date.now(),
    });
    return _state;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e: any) {
    // electron-updater also fires its own 'error' event for the
    // same condition, so the listener has already set state to
    // 'error'. We just re-throw so the IPC caller sees it too.
    log.warn('[updater] checkForUpdates threw', e);
    throw e;
  }
  return _state;
}

/**
 * Returns the current state snapshot. Cheap; reads in-memory.
 * IPC handler `update:status` calls this.
 */
export function getUpdateState(): UpdateState {
  return _state;
}

/**
 * Quit the app and install the downloaded update. Caller is
 * responsible for ensuring the quiesce manager has drained
 * in-flight turns BEFORE invoking this. Returns false if no
 * downloaded update is available (defensive — the IPC handler
 * shouldn't allow this in the first place, but belt-and-suspenders).
 */
export function installDownloadedUpdate(): boolean {
  if (_state.state !== 'downloaded') {
    log.warn(
      `[updater] installDownloadedUpdate called but state is '${_state.state}', no-op`
    );
    return false;
  }
  log.info('[updater] quitAndInstall — restarting into new version');
  // isSilent=false: show the installer UI on Windows (one-line
  // progress dialog). isForceRunAfter=true: launch the new app
  // automatically after install. macOS/Linux both ignore the silent
  // flag.
  autoUpdater.quitAndInstall(false, true);
  return true;
}
