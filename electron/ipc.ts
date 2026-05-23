import { ipcMain, BrowserWindow, dialog, app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import log from 'electron-log';
import {
  listProjects,
  setProjectName,
  setProjectVisuals,
  setProjectArchived,
  listSessionsForProject,
  listSessionsAll,
  setSessionUserTitle,
  setSessionVisuals,
  setSessionArchived,
  setSessionState,
  setSessionPending,
  getSessionPending,
  setSessionApiKey,
  deleteSession,
  upsertProject,
  upsertSession,
  getSetting,
  setSetting,
  listSettings,
  listAuditEvents,
  type AuditEventRow,
} from './db';
import {
  rollingDaySpendMicros,
  todaySpendMicros,
  currentHourSpendMicros,
  getDailyBudgetMicros,
  getHourCapMicros,
  setBypassNextTurn,
  resetBudgetAdjustment,
} from './budget';
import { importClaudeProjects } from './claudeImport';
import { listMcpServers, signInMcp, signOutMcp } from './mcp';
import {
  hasApiKey,
  setApiKey,
  listApiKeys,
  createApiKey,
  updateApiKeyFields,
  setApiKeyAsDefault,
  deleteApiKeyById,
  getDefaultApiKeyId,
} from './secret';
import { resetClient } from './anthropic';
import {
  ensureOurPathSeeded,
  loadMessagesFromJsonl,
  loadMessagesWithTsFromJsonl,
  ourJsonlPath,
} from './sessionRuntime';
import {
  runUserTurn,
  cancelRun,
  isRunning,
  queueInterrupt,
  removeInterrupt,
} from './agent';

export function registerIpc(getMainWindow: () => BrowserWindow | null) {
  // ---- Sessions (primary entity in the UI) ----
  ipcMain.handle('sessions:listAll', () => listSessionsAll());

  ipcMain.handle('sessions:rename', (_e, id: string, title: string | null) => {
    setSessionUserTitle(id, title && title.trim() ? title.trim() : null);
    return listSessionsAll();
  });

  ipcMain.handle(
    'sessions:setVisuals',
    (_e, id: string, color: string | null, emoji: string | null) => {
      setSessionVisuals(id, color, emoji);
      return listSessionsAll();
    }
  );

  ipcMain.handle('sessions:archive', (_e, id: string, archived: boolean) => {
    setSessionArchived(id, archived);
    return listSessionsAll();
  });

  ipcMain.handle('sessions:deleteFromDisk', async (_e, id: string) => {
    // Refuse to delete a session that's actively running. Otherwise the
    // running agent would keep appending to a JSONL whose row no longer
    // exists, and the next listAll wouldn't show the new turn but
    // memory / disk state would still be growing.
    if (isRunning(id)) {
      log.warn(`[ipc] deleteFromDisk refused: session ${id} is running`);
      throw new Error(
        'Session is currently running. Cancel the turn first, then delete.'
      );
    }
    // Look up the JSONL path BEFORE deleting the row (the row carries
    // jsonl_path; once gone we wouldn't know what file to unlink).
    const row = listSessionsAll().find((s) => s.id === id);
    const jsonlPath = row?.jsonl_path ?? null;
    // Always delete our own canonical copy under ~/.guycode/sessions —
    // this exists for every session we've ever loaded, regardless of
    // whether the original came from Claude.
    const guyJsonl = ourJsonlPath(id);
    // Best-effort unlinks. We keep going even if one fails so the user
    // doesn't end up with a half-deleted state.
    for (const p of [guyJsonl, jsonlPath]) {
      if (!p) continue;
      try {
        if (existsSync(p)) {
          unlinkSync(p);
          log.info(`[ipc] deleteFromDisk unlinked ${p}`);
        }
      } catch (e) {
        log.warn(
          `[ipc] deleteFromDisk failed to unlink ${p}: ${(e as Error).message}`
        );
      }
    }
    // Finally drop the DB row (and dependent rows). This is what makes
    // it disappear from the sidebar.
    deleteSession(id);
    return listSessionsAll();
  });

  ipcMain.handle('sessions:setState', (_e, id: string, state: string) => {
    setSessionState(id, state);
    return listSessionsAll();
  });

  // Bind a session to a specific API key (or pass null to clear the
  // binding so it inherits the current default at agent-run time).
  // Surfaced via the right-click "Change API key" submenu in the sidebar.
  ipcMain.handle(
    'sessions:setApiKey',
    (_e, id: string, apiKeyId: string | null) => {
      setSessionApiKey(id, apiKeyId);
      return listSessionsAll();
    }
  );

  // Clear a queued (budget-paused) user message without auto-resuming.
  // Used when the user changes their mind about what they typed while the
  // session was sleeping and wants to discard it instead of letting the
  // resume sweep fire it at the top of the next hour.
  ipcMain.handle('sessions:cancelPending', (_e, id: string) => {
    const row = getSessionPending(id);
    if (row?.pending_user_text) {
      log.info(
        `[ipc] cancelPending: discarding queued message for ${id} (${row.pending_user_text.length} chars)`
      );
    }
    setSessionPending(id, null, null);
    return listSessionsAll();
  });

  // ---- Projects (legacy / cwd grouping; kept for completeness) ----
  ipcMain.handle('projects:list', () => listProjects());
  ipcMain.handle('projects:rename', (_e, id: string, name: string | null) => {
    setProjectName(id, name && name.trim() ? name.trim() : null);
    return listProjects();
  });
  ipcMain.handle(
    'projects:setVisuals',
    (_e, id: string, color: string | null, emoji: string | null) => {
      setProjectVisuals(id, color, emoji);
      return listProjects();
    }
  );
  ipcMain.handle('projects:archive', (_e, id: string, archived: boolean) => {
    setProjectArchived(id, archived);
    return listProjects();
  });
  ipcMain.handle('projects:listSessions', (_e, projectId: string) =>
    listSessionsForProject(projectId)
  );

  // ---- Settings ----
  ipcMain.handle('settings:get', (_e, key: string) => getSetting(key));
  ipcMain.handle('settings:set', (_e, key: string, value: string) =>
    setSetting(key, value)
  );
  ipcMain.handle('settings:list', () => listSettings());

  // ---- Audit log ----
  ipcMain.handle(
    'audit:list',
    (_e, opts?: { sessionId?: string; limit?: number; beforeId?: number | null }): AuditEventRow[] =>
      listAuditEvents(opts ?? {})
  );

  // ---- Budget telemetry (for the sidebar status pill) ----
  // `apiKeyId` narrows the view to a single key; null/undefined aggregates
  // across every key (and includes legacy un-keyed events). The sidebar
  // dropdown uses this to switch between "All keys" / "Work" / "Personal".
  ipcMain.handle('budget:status', (_e, apiKeyId?: string | null) => {
    const now = Date.now();
    const id = apiKeyId ?? null;
    const dailyCap = getDailyBudgetMicros(id);
    const hourCap = getHourCapMicros(id);
    return {
      apiKeyId: id,
      // Hourly cap in micros (= daily / 24), or null when uncapped.
      // This is the cap the governor actually enforces.
      hourCapMicros: hourCap,
      // Current clock-hour bucket spend on this key.
      hourSpentMicros: currentHourSpendMicros(now, id),
      // Daily budget in micros, or null when uncapped. Informational
      // only — it's the human-facing knob; enforcement is hourly.
      dailyCapMicros: dailyCap,
      // Today's spend (local-day) on this key — informational, mirrors
      // the configured daily budget for context.
      daySpentMicros: todaySpendMicros(now, id),
      // Rolling 24h spend — used for the no-budget-set fallback display
      // so users see their recent activity even when the governor isn't
      // gating anything.
      last24hSpentMicros: rollingDaySpendMicros(now, id),
    };
  });

  // ---- Multi API key management ------------------------------------
  ipcMain.handle('apiKeys:list', () => listApiKeys());
  ipcMain.handle(
    'apiKeys:create',
    (
      _e,
      args: {
        name: string;
        plain: string;
        dailyBudgetUsd?: number | null;
        perTurnCapUsd?: number | null;
        setDefault?: boolean;
      }
    ) => {
      const id = createApiKey(args);
      return { ok: !!id, id, keys: listApiKeys() };
    }
  );
  ipcMain.handle(
    'apiKeys:update',
    (
      _e,
      id: string,
      patch: {
        name?: string;
        plain?: string;
        dailyBudgetUsd?: number | null;
        perTurnCapUsd?: number | null;
      }
    ) => {
      const ok = updateApiKeyFields(id, patch);
      // Key plaintext may have changed — drop its cached Anthropic client.
      resetClient(id);
      return { ok, keys: listApiKeys() };
    }
  );
  ipcMain.handle('apiKeys:setDefault', (_e, id: string) => {
    setApiKeyAsDefault(id);
    return listApiKeys();
  });
  ipcMain.handle('apiKeys:delete', (_e, id: string) => {
    deleteApiKeyById(id);
    resetClient(id);
    return { keys: listApiKeys(), sessions: listSessionsAll() };
  });

  // Zero out a key's accumulated hourly carry-over and re-anchor to the
  // current hour. `usage_events` rows are NOT deleted — historical spend
  // totals remain accurate, only the carry-over adjustment chain is
  // reset. Used when the user wants a clean slate (e.g. after a budget
  // logic bug or a large unintended overage they don't want amortized
  // across future hours). The Settings page surfaces this as a per-key
  // "Reset overages/underages" button.
  ipcMain.handle('apiKeys:resetBudgetAdjustment', (_e, id: string) => {
    resetBudgetAdjustment(id);
    return { ok: true, keys: listApiKeys() };
  });

  // ---- MCP servers ----
  ipcMain.handle('mcp:list', () => listMcpServers());
  ipcMain.handle('mcp:signIn', (_e, name: string) => signInMcp(name));
  ipcMain.handle('mcp:signOut', (_e, name: string) => signOutMcp(name));

  // Force-resume a session even if its daily cap is full. One-shot bypass.
  // The session is moved out of `sleeping-budget` and its pending message is
  // re-fired through the normal turn flow.
  ipcMain.handle('budget:forceResume', (_e, sessionId: string) => {
    const pending = getSessionPending(sessionId);
    setBypassNextTurn(sessionId);
    setSessionState(sessionId, 'idle');
    // Clear pending so the resume sweep doesn't double-fire later.
    setSessionPending(sessionId, null, null);
    if (pending?.pending_user_text && pending.pending_user_text.trim()) {
      const sess = listSessionsAll().find((s) => s.id === sessionId);
      if (sess) {
        runUserTurn({
          sessionId,
          projectId: sess.project_id,
          cwd: sess.cwd ?? '',
          userText: pending.pending_user_text,
          seedFromJsonl: sess.jsonl_path,
        }).catch(() => {
          /* error is broadcast as agent:event */
        });
      }
    }
    return { ok: true };
  });

  // ---- Imports ----
  ipcMain.handle('import:run', async () => {
    const w = getMainWindow();
    return importClaudeProjects(w);
  });

  // ---- Secret / API key ----
  ipcMain.handle('secret:hasKey', () => hasApiKey());
  ipcMain.handle('secret:setKey', (_e, key: string) => setApiKey(key));

  // ---- Native dialogs ----
  ipcMain.handle('dialog:pickDirectory', async (_e, opts?: { defaultPath?: string }) => {
    const w = getMainWindow();
    const r = await dialog.showOpenDialog(w!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: opts?.defaultPath ?? app.getPath('home'),
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  // ---- Agent ----
  ipcMain.handle('agent:loadMessages', (_e, sessionId: string, opts?: { fallbackPath?: string }) => {
    const ours = ourJsonlPath(sessionId);

    // Try to seed ourPath from the imported Claude Code JSONL. This is a
    // best-effort operation — even if it fails (disk full, permissions, huge
    // file, etc.) we still want to render history by reading the seed
    // directly. NEVER let a seed failure surface as "empty conversation".
    if (opts?.fallbackPath) {
      try {
        ensureOurPathSeeded(ours, opts.fallbackPath);
      } catch (e) {
        log.error('[agent:loadMessages] ensureOurPathSeeded failed', {
          sessionId,
          fallbackPath: opts.fallbackPath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Prefer ours if it exists AND has actual content (a 0-byte file would
    // indicate an incomplete write — fall through to the seed in that case).
    try {
      if (existsSync(ours)) {
        const msgs = loadMessagesWithTsFromJsonl(ours);
        if (msgs.length > 0) return msgs;
        log.warn(
          `[agent:loadMessages] ours has no parseable messages, trying seed (sessionId=${sessionId})`
        );
      }
    } catch (e) {
      log.error('[agent:loadMessages] failed reading ours', {
        sessionId,
        ours,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Fallback: read the original seed file directly. For unimported sessions
    // (native Guy) opts.fallbackPath === ours, so this branch isn't taken.
    if (opts?.fallbackPath && existsSync(opts.fallbackPath)) {
      try {
        return loadMessagesWithTsFromJsonl(opts.fallbackPath);
      } catch (e) {
        log.error('[agent:loadMessages] failed reading seed', {
          sessionId,
          seedPath: opts.fallbackPath,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Silence unused-import warning in dev; this branch exists for parity.
    void loadMessagesFromJsonl;
    return [];
  });

  ipcMain.handle(
    'agent:run',
    async (
      _e,
      args: {
        sessionId: string;
        projectId: string;
        cwd: string;
        userText: string;
        attachments?: unknown[];
        seedFromJsonl?: string | null;
      }
    ) => {
      // fire-and-forget; status streams via agent:event
      runUserTurn(args).catch(() => {
        /* error already broadcast as agent:event */
      });
      return { started: true, alreadyRunning: false };
    }
  );

  ipcMain.handle('agent:cancel', (_e, sessionId: string) => {
    cancelRun(sessionId);
    return { ok: true };
  });

  ipcMain.handle('agent:interrupt', (_e, sessionId: string, text: string) => {
    // Push text onto the per-session interrupt queue. The agent loop drains
    // it between tool rounds and inlines it into the next user message —
    // search for `drainInterrupts` in agent.ts.
    const pending = queueInterrupt(sessionId, text);
    return { ok: true, pending };
  });

  ipcMain.handle(
    'agent:removeInterrupt',
    (_e, sessionId: string, text: string) => {
      // Renderer "×" on a queued bubble. Matches by exact text. Race-safe:
      // if the agent already drained this entry, removed=false and the UI
      // is about to receive `interrupt_picked_up` anyway.
      const removed = removeInterrupt(sessionId, text);
      return { ok: true, removed };
    }
  );

  ipcMain.handle('agent:isRunning', (_e, sessionId: string) => isRunning(sessionId));

  // ---- Sessions: create / continue ----
  ipcMain.handle(
    'sessions:create',
    (_e, args: { cwd: string; title?: string | null; apiKeyId?: string | null }) => {
      // Empty cwd means "no folder binding" — all Guy-created sessions
      // without an explicit cwd share a single synthetic project.
      const cwd = (args.cwd ?? '').trim();
      const projectId = cwd ? projectIdFromCwd(cwd) : '__guy_default__';
      upsertProject({
        id: projectId,
        cwd: cwd,
        lastActivityTs: Date.now(),
        createdAt: Date.now(),
      });
      const id = randomUUID();
      upsertSession({
        id,
        projectId,
        jsonlPath: ourJsonlPath(id),
        jsonlMtime: Date.now(),
        jsonlSize: 0,
        startedAt: Date.now(),
        endedAt: null,
        messageCount: 0,
        lastMessagePreview: null,
        title: args.title ? args.title.trim() : null,
      });
      setSessionState(id, 'idle');
      // Bind to the explicit api key the caller asked for; otherwise to
      // the current default. Sessions with no binding fall back to the
      // default at agent-run time, which means promoting a different
      // key to default mid-conversation transparently moves them.
      // Storing an explicit id at creation time gives the user a stable
      // "this session uses key X" guarantee that survives default
      // changes — matching the right-click menu's expectation.
      const apiKeyId =
        args.apiKeyId && args.apiKeyId.trim()
          ? args.apiKeyId.trim()
          : getDefaultApiKeyId();
      if (apiKeyId) {
        setSessionApiKey(id, apiKeyId);
      }
      return { id, projectId, cwd, apiKeyId };
    }
  );
}

/** Encode a Windows/Unix cwd path the same way Claude Code does. */
function projectIdFromCwd(cwd: string): string {
  return cwd.replace(/[\\:/]/g, '-');
}
