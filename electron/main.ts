import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import log from 'electron-log';
import {
  db,
  initDb,
  resetStaleRunningSessions,
  resetArchivedRunningSessions,
  getSetting,
} from './db';
import { registerIpc } from './ipc';
import { importClaudeProjects } from './claudeImport';
import { bootstrapApiKey, hasApiKey } from './secret';
import { startGovernor, stopGovernor } from './budget';
import { cleanupArchives } from './toolSummarizer';
import { initMcp, shutdownMcp } from './mcp';
import { setAttachApprovalPrompter } from './chromeExtBridge';
import { initAutoUpdater, shutdownAutoUpdater } from './autoUpdater';

log.initialize();
log.transports.file.level = 'info';

let mainWindow: BrowserWindow | null = null;

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#0e0f12',
    title: 'Guy Code',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }

  // Send any http(s) link clicks (target="_blank" anchors) out to the
  // user's default browser instead of opening a new BrowserWindow inside
  // Electron. Anything else (file://, data:, etc.) is denied for safety.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        shell.openExternal(url);
      }
    } catch {
      /* ignore malformed URLs */
    }
    return { action: 'deny' };
  });

  // Block in-window navigation to external URLs — only the dev server URL
  // and our local file:// app shell are allowed. Without this, a stray
  // <a href> without target="_blank" would replace the renderer.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allow =
      (isDev && url.startsWith(process.env.VITE_DEV_SERVER_URL!)) ||
      url.startsWith('file://');
    if (!allow) {
      event.preventDefault();
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          shell.openExternal(url);
        }
      } catch {
        /* ignore */
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await initDb();
  } catch (e) {
    log.error('[main] failed to open DB', e);
    // Continue anyway — the UI will show the error state.
  }

  // Crash-recovery: any session left in `running` or `waiting-on-system` on
  // disk is stale (the agent process that owned that state is gone). Clear
  // them back to `idle` so the sidebar doesn't show ghost-running sessions
  // that the user can't interact with. Must run after initDb() but before
  // the window/IPC come up, so the first `sessions:listAll` call already
  // sees clean state.
  try {
    const n = resetStaleRunningSessions();
    if (n > 0) {
      log.info(`[main] cleared ${n} stale running/waiting-on-system session(s) on startup`);
    }
  } catch (e) {
    log.warn('[main] resetStaleRunningSessions failed', e);
  }

  // One-time backfill for the "archive doesn't stop runtime" bug fix:
  // any archived session left in a runnable state by a pre-fix install
  // gets idled here. This is BELT-AND-SUSPENDERS with the new
  // sessions:archive IPC handler (which idles on the way in) — the
  // handler covers all NEW archives, this covers existing archived
  // rows that were stuck before the handler was changed. Specifically
  // this catches archived rows whose state is running,
  // waiting-on-system, waiting-on-user, or sleeping-budget, plus
  // clears their pending_user_text so the resume sweep can never
  // re-wake them.
  try {
    const n = resetArchivedRunningSessions();
    if (n > 0) {
      log.info(
        `[main] backfill: idled ${n} archived session(s) that were stuck in a runnable state`
      );
    }
  } catch (e) {
    log.warn('[main] resetArchivedRunningSessions failed', e);
  }

  // Diagnostic: count archived vs non-archived sessions at startup. Helps
  // distinguish "the DB lost the archived bit" (a backend bug — count of
  // archived=1 is suspiciously low) from "the renderer is filtering wrong"
  // (DB has archived=1 rows but they show up in Active anyway). The user
  // reported archived sessions reappearing in Active after restart; this
  // log tells us which side of the IPC boundary the bug lives on.
  try {
    const counts = db()
      .prepare(
        `SELECT
           SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
           SUM(CASE WHEN archived = 0 OR archived IS NULL THEN 1 ELSE 0 END) AS active,
           COUNT(*) AS total
         FROM sessions`
      )
      .get<{ archived: number | null; active: number | null; total: number }>();
    log.info(
      `[main] session archive counts at startup — total=${counts?.total ?? 0} ` +
        `archived=${counts?.archived ?? 0} active=${counts?.active ?? 0}`
    );
    if ((counts?.archived ?? 0) > 0) {
      // Print up to 5 archived session ids + titles so the user can confirm
      // these are the ones they expect.
      const rows = db()
        .prepare(
          `SELECT id, COALESCE(user_title, title, '(untitled)') AS title
             FROM sessions WHERE archived = 1 ORDER BY ended_at DESC LIMIT 5`
        )
        .all<{ id: string; title: string }>();
      for (const r of rows) {
        log.info(`[main] archived: ${r.id.slice(0, 8)} "${r.title}"`);
      }
    }
  } catch (e) {
    log.warn('[main] archive-count diagnostic failed', e);
  }

  // Bootstrap the API key (from disk file or env var, encrypted into DB).
  try {
    const r = bootstrapApiKey();
    log.info(`[main] api key bootstrap: source=${r.source} ok=${r.ok}`);
    if (!hasApiKey()) {
      log.warn('[main] no API key configured — agent runs will fail until set');
    }
    // Post-bootstrap diagnostic: confirm the legacy migration didn't blow
    // away `archived = 1`. The backfill UPDATE in secret.ts only touches
    // api_key_id, but I want belt-and-suspenders evidence in the log.
    try {
      const post = db()
        .prepare(
          `SELECT SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived FROM sessions`
        )
        .get<{ archived: number | null }>();
      log.info(
        `[main] archived-count post-bootstrap=${post?.archived ?? 0}`
      );
    } catch {
      /* non-fatal */
    }
  } catch (e) {
    log.error('[main] api key bootstrap threw', e);
  }

  registerIpc(() => mainWindow);
  createWindow();

  // Wire the BrowserAttach approval prompter. The bridge calls this
  // every time the agent tries to authorize a pre-existing tab via
  // BrowserAttach; we show a native modal so the user has to
  // explicitly OK each one. No prompter wired = fail closed (deny).
  setAttachApprovalPrompter(async ({ tabId, url, title }) => {
    const w = mainWindow;
    // Truncate long titles / URLs so the dialog stays readable.
    const niceTitle =
      title.length > 80 ? title.slice(0, 77) + '…' : title || '(untitled)';
    const niceUrl = url.length > 100 ? url.slice(0, 97) + '…' : url;
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      title: 'Allow agent to drive Chrome tab?',
      message: 'The agent wants to operate on one of your existing Chrome tabs.',
      detail:
        `Title:  ${niceTitle}\n` +
        `URL:    ${niceUrl}\n` +
        `Tab id: ${tabId}\n\n` +
        'If you allow this, the agent will be able to click, type, ' +
        'press keys, scroll, screenshot, and run JavaScript in this ' +
        "tab — until you disconnect the Chrome connector.\n\n" +
        'Only allow if you specifically asked the agent to use this ' +
        "tab. Otherwise click Deny — the agent will open its own tab " +
        'instead.',
      buttons: ['Deny', 'Allow'],
      defaultId: 0, // Deny is the safe default (Enter on a no-op)
      cancelId: 0, // Esc / window close = Deny
      noLink: true, // Windows: don't render the buttons as hyperlinks
    };
    try {
      const r = w
        ? await dialog.showMessageBox(w, opts)
        : await dialog.showMessageBox(opts);
      return r.response === 1; // 1 = "Allow"
    } catch (e) {
      log.warn('[main] BrowserAttach dialog threw, denying by default', e);
      return false;
    }
  });

  startGovernor();
  // Sweep stale archived tool results in the background. Best-effort;
  // failures are logged but don't block startup.
  try {
    cleanupArchives();
  } catch (e) {
    log.warn('[main] tool-result archive cleanup failed', e);
  }
  // Fire MCP init in the background; failures are non-fatal so we don't
  // block the window. Individual servers are isolated by mcp.ts.
  initMcp().catch((e) => log.error('[main] MCP init failed', e));
  // Initialize the auto-updater. In dev (`!app.isPackaged`) this is a
  // no-op — the renderer's update banner just never fires. In a
  // packaged build it kicks off the initial update check after a 30 s
  // grace and polls every 4 hours thereafter. The renderer subscribes
  // to state via the `update:event` IPC broadcast.
  try {
    initAutoUpdater(() => mainWindow);
  } catch (e) {
    log.error('[main] autoUpdater init failed (continuing without auto-update)', e);
  }

  // Sticky Chrome auto-reconnect. If the user successfully connected
  // the Chrome connector on a previous run, the IPC handler in
  // `chrome:connect` saved the port to `chrome.autoConnectPort`. We
  // restore that connection in the background here so the user
  // doesn't have to click Settings → Connect on every app start.
  // Disconnect clears the setting, so this only fires when the user
  // was deliberately connected when they last quit. Failures are
  // non-fatal — a stale port, missing extension, or busy port just
  // leaves the connector disconnected and the user can click
  // Connect manually with a useful error in Settings.
  const autoConnectRaw = (() => {
    try {
      return getSetting('chrome.autoConnectPort');
    } catch (e) {
      log.warn('[main] reading chrome.autoConnectPort setting failed', e);
      return null;
    }
  })();
  if (autoConnectRaw && autoConnectRaw.trim()) {
    const portNum = Number(autoConnectRaw.trim());
    const port = Number.isFinite(portNum) && portNum > 0 ? portNum : undefined;
    setTimeout(async () => {
      try {
        const { connect } = await import('./chromeExtBridge');
        await connect(port);
        log.info(
          `[main] Chrome auto-reconnect succeeded on port ${port ?? '(default)'}`
        );
      } catch (e: any) {
        // Don't surface this as a startup error — the user will see
        // the disconnected pill in Settings if they go look. Logging
        // the message helps debugging "why didn't it auto-connect"
        // questions later.
        log.warn(
          `[main] Chrome auto-reconnect failed (will require manual Connect click): ${e?.message ?? e}`
        );
      }
    }, 1500);
  }

  // Kick off import in the background after the window is ready.
  setTimeout(() => {
    importClaudeProjects(mainWindow)
      .then(() => {
        // Post-import diagnostic: same archived-count snapshot. If this
        // number is lower than the startup count, the import is the
        // culprit (probably a row being inserted instead of conflicting
        // with the existing archived row).
        try {
          const post = db()
            .prepare(
              `SELECT SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived FROM sessions`
            )
            .get<{ archived: number | null }>();
          log.info(
            `[main] archived-count post-import=${post?.archived ?? 0}`
          );
        } catch {
          /* non-fatal */
        }
      })
      .catch((e) => log.error('[main] import failed', e));
  }, 500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopGovernor();
  shutdownAutoUpdater();
  shutdownMcp().catch(() => {
    /* best effort */
  });
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (e) => {
  log.error('[uncaught]', e);
});
