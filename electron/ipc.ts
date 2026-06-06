import { ipcMain, BrowserWindow, dialog, app, clipboard, nativeImage } from 'electron';
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
  setSessionForceContinue,
  setSessionArchived,
  setSessionState,
  setSessionPending,
  setSessionWakeAt,
  setSessionDraft,
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
  getBaseHourCapMicros,
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
import { loadSkills } from './skills';
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
import { deleteSessionAttachments } from './attachments';

export function registerIpc(getMainWindow: () => BrowserWindow | null) {
  // ---- App metadata ----
  //
  // `app.getVersion()` returns the version embedded at build time. For
  // production builds the release CI workflow rewrites `package.json`'s
  // version field from the pushed git tag BEFORE running
  // electron-builder, so the embedded version is always identical to
  // the GitHub release tag (no drift possible). In dev (`npm run dev`)
  // this returns whatever package.json currently says, which is fine —
  // dev builds aren't released. Surfaced in the renderer via the
  // Settings footer and as a tooltip on the title bar.
  ipcMain.handle('app:version', () => app.getVersion());

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
    // When archiving: forcibly stop any in-flight or scheduled activity on
    // this session so it can't continue spending tokens / hitting tools /
    // waking from sleeping-budget. The archived flag is treated as
    // "deactivated" — the session is hidden AND inert until unarchived.
    //
    // Order matters:
    //   1. Cancel any active turn FIRST so the AbortController fires
    //      while the JSONL/state writes from the in-flight loop are
    //      still considered "live". cancelRun is a no-op if nothing
    //      is running, so this is safe for the common case where the
    //      user archives an idle session.
    //   2. Clear pending_user_text and sleeping_since BEFORE flipping
    //      the archived flag — protects against a race where the
    //      resume sweep fires between the archive write and our
    //      idle-state write below.
    //   3. Force state → idle if the session was in any active state.
    //      `error` is preserved (post-mortem visibility), `idle` is
    //      already correct.
    //   4. Finally flip the archived flag.
    // When unarchiving: just flip the flag. The session is now visible
    // and runnable again, but stays in `idle` — the user must explicitly
    // send a message to continue. We do NOT auto-resume any prior
    // pending text, both because that text was cleared at archive time
    // and because surprising users with a delayed auto-fire would be
    // worse UX than making them re-send.
    if (archived) {
      try {
        // cancelRun also tears down any sleeping-tool wake timer +
        // idles the row if it was in sleeping-tool — so the archived
        // session can't auto-wake from a still-armed timer.
        cancelRun(id);
      } catch (e) {
        log.warn(`[ipc] cancelRun while archiving ${id} failed`, e);
      }
      try {
        setSessionPending(id, null, null);
      } catch (e) {
        log.warn(`[ipc] clear-pending while archiving ${id} failed`, e);
      }
      try {
        // Clear any persistent wake marker — the timer was already
        // cleared above by cancelRun, but the DB column is the
        // durable source of truth for the post-restart sweep.
        setSessionWakeAt(id, null);
      } catch (e) {
        log.warn(`[ipc] clear-wake while archiving ${id} failed`, e);
      }
      // Find the current state and idle it unless it's terminal.
      // cancelRun already idled sleeping-tool sessions; we still do
      // this defensively for any other non-terminal state
      // (running, waiting-on-system, waiting-on-user, sleeping-budget).
      const row = listSessionsAll().find((s) => s.id === id);
      const st = row?.state ?? 'idle';
      if (st !== 'idle' && st !== 'error') {
        try {
          setSessionState(id, 'idle');
        } catch (e) {
          log.warn(`[ipc] state→idle while archiving ${id} failed`, e);
        }
      }
    }
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
    // Best-effort: also wipe any disk-backed attachments saved under
    // ~/.guycode/attachments/<sessionId>/. The session can't reference
    // them anymore once the JSONL is gone, and they'd otherwise leak
    // disk space indefinitely. Failures are logged but don't block
    // the deletion (the row removal is what the user will check for).
    try {
      deleteSessionAttachments(id);
    } catch (e) {
      log.warn(
        `[ipc] deleteFromDisk: attachments cleanup failed: ${(e as Error).message}`
      );
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

  // Persist (or clear) per-session draft text.
  //
  // Called by the Composer's debounced-write effect on the renderer
  // side: every keystroke updates local React state for instant UI
  // response, and a 500-ms-idle debounce calls this handler to
  // commit the latest draft to SQLite. Submit-success calls it with
  // null/'' to clear the row.
  //
  // Performance note: even at heavy typing speeds (~10 chars/sec),
  // the debounce coalesces to ~2 calls/sec MAX (one settle per
  // typing burst). Each call is a single keyed UPDATE — well below
  // the rate where SQLite contention or IPC marshaling would matter.
  // We deliberately do NOT return the refreshed sessions array
  // here: a draft write is hot-path and the renderer doesn't need
  // a sidebar refresh — the draft never appears outside its own
  // composer. Saves a full scan-and-marshal on every settle.
  //
  // Empty/whitespace-only drafts normalize to NULL so the row goes
  // back to "no draft" (matters for the post-restart hydration —
  // we don't want to restore a textarea to a single accidental
  // space).
  ipcMain.handle(
    'sessions:setDraft',
    (_e, id: string, draft: string | null) => {
      const normalized =
        draft && draft.trim().length > 0 ? draft : null;
      setSessionDraft(id, normalized);
    }
  );

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
      // This is the cap the governor actually enforces. NOTE: this is the
      // EFFECTIVE cap and goes NEGATIVE when the key has accumulated
      // overspend — callers deciding "is a budget configured" must use
      // dailyCapMicros / baseHourCapMicros, not `hourCapMicros > 0`.
      hourCapMicros: hourCap,
      // Un-adjusted base hourly slice (daily / active-hours-per-day), or
      // null when no daily budget is set. Stable denominator for the UI.
      baseHourCapMicros: getBaseHourCapMicros(id),
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
        // Active-hours window for budget redistribution. Both 0..23;
        // equal values (including 0/0 default) = all-day. See
        // `electron/budget.ts` for window semantics + math.
        activeHourStart?: number;
        activeHourEnd?: number;
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
        activeHourStart?: number;
        activeHourEnd?: number;
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

  // Force-resume a session even if its daily cap is full. Opens a 60s
  // budget grace window (see budget.ts FORCE_RESUME_GRACE_MS) so the
  // model's whole multi-call turn can complete instead of pausing
  // again on the next API call. Mirrors the resume sweep's two-mode
  // logic: pending user text → fresh turn, otherwise → continue the
  // in-flight loop using the JSONL as truth. Without the second case,
  // a mid-turn pause (where the model stopped between API calls but
  // the user hadn't typed anything new) couldn't be unstuck — the
  // user clicked Force Resume but nothing happened.
  ipcMain.handle('budget:forceResume', (_e, sessionId: string) => {
    const pending = getSessionPending(sessionId);
    setBypassNextTurn(sessionId);
    setSessionState(sessionId, 'idle');
    // Clear pending so the resume sweep doesn't double-fire later.
    setSessionPending(sessionId, null, null);
    const sess = listSessionsAll().find((s) => s.id === sessionId);
    if (!sess) return { ok: true };
    const pendingText = pending?.pending_user_text?.trim() ?? '';
    if (pendingText) {
      // Fresh-turn case: the user typed something while sleeping
      // (or before it slept) and that text was parked. Send it now.
      runUserTurn({
        sessionId,
        projectId: sess.project_id,
        cwd: sess.cwd ?? '',
        userText: pendingText,
        seedFromJsonl: sess.jsonl_path,
      }).catch(() => {
        /* error is broadcast as agent:event */
      });
    } else {
      // Mid-flight case: the model paused mid-turn (between API
      // calls). JSONL has the partial state; keep going with no
      // new user message.
      runUserTurn({
        sessionId,
        projectId: sess.project_id,
        cwd: sess.cwd ?? '',
        userText: '',
        continueExisting: true,
        seedFromJsonl: sess.jsonl_path,
      }).catch(() => {
        /* error is broadcast as agent:event */
      });
    }
    return { ok: true };
  });

  ipcMain.handle(
    'sessions:setForceContinue',
    (_e, sessionId: string, on: boolean) => {
      setSessionForceContinue(sessionId, !!on);
      // If we just turned it ON and the session is sitting paused on the
      // budget, resume it immediately (same path as a manual Force Resume)
      // rather than waiting up to 60s for the next resume sweep. The
      // precheck now allows every call for this session, so it won't
      // re-pause. Turning it OFF is a no-op on a running session — the next
      // budget pause will simply take effect normally.
      if (on) {
        const sess = listSessionsAll().find((s) => s.id === sessionId);
        if (sess && sess.state === 'sleeping-budget') {
          const pending = getSessionPending(sessionId);
          setSessionState(sessionId, 'idle');
          setSessionPending(sessionId, null, null);
          const pendingText = pending?.pending_user_text?.trim() ?? '';
          runUserTurn({
            sessionId,
            projectId: sess.project_id,
            cwd: sess.cwd ?? '',
            userText: pendingText,
            continueExisting: pendingText === '',
            seedFromJsonl: sess.jsonl_path,
          }).catch(() => {
            /* error is broadcast as agent:event */
          });
        }
      }
      return { ok: true, sessions: listSessionsAll() };
    }
  );

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

  // ---- Inline images: copy to clipboard / save to disk ----
  //
  // Done in the main process so we get the OS clipboard + a native save dialog
  // and can fetch remote URLs without CORS. `src` is a data:, file://, or
  // http(s):// URL coming from an inline image the user clicked.
  async function loadImageBytes(src: string): Promise<{ buf: Buffer; ext: string }> {
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',');
      const meta = src.slice(5, comma); // e.g. "image/png;base64"
      const b64 = src.slice(comma + 1);
      const mt = meta.split(';')[0] || 'image/png';
      const ext = mt.split('/')[1] || 'png';
      return { buf: Buffer.from(b64, 'base64'), ext };
    }
    if (src.startsWith('file://')) {
      const { readFileSync } = await import('node:fs');
      const { fileURLToPath } = await import('node:url');
      const p = fileURLToPath(src);
      const ext = (p.split('.').pop() || 'png').toLowerCase();
      return { buf: readFileSync(p), ext };
    }
    // http(s): fetch in main (no CORS).
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const ab = await res.arrayBuffer();
    const ct = res.headers.get('content-type') || 'image/png';
    const ext = (ct.split('/')[1] || 'png').split(';')[0];
    return { buf: Buffer.from(ab), ext };
  }

  ipcMain.handle('image:copy', async (_e, src: string) => {
    try {
      const { buf } = await loadImageBytes(src);
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return { ok: false, error: 'unsupported or empty image' };
      clipboard.writeImage(img);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('image:save', async (_e, src: string, suggestedName?: string) => {
    try {
      const { buf, ext } = await loadImageBytes(src);
      const w = getMainWindow();
      const def =
        suggestedName ||
        `guycode-image-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      const r = await dialog.showSaveDialog(w!, {
        defaultPath: `${app.getPath('downloads')}/${def}`,
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(r.filePath, buf);
      return { ok: true, path: r.filePath };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
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

  // ---- Skills (slash-command autocomplete) -----------------------------
  // Returns the skill list visible from a given cwd. The renderer caches
  // this per-cwd and uses it to populate the slash-command menu in the
  // Composer. Cheap to call; loadSkills is just a small filesystem scan.
  ipcMain.handle('skills:list', (_e, cwd: string | null) => {
    const reg = loadSkills(cwd ?? null);
    // Strip body from the wire payload — bodies can be large and the
    // autocomplete UI only needs name + description. The model still
    // gets bodies via the Skill tool when it actually invokes one.
    return {
      skills: reg.skills.map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
      })),
    };
  });

  // ---- Chrome connector ----------------------------------------------
  //
  // Status / connect / disconnect surface the singleton in
  // chromeBridge.ts. The Settings UI polls `chrome:status` while open
  // (same pattern as MCP) so the user sees the connection light flip
  // green/red as Chrome is launched / killed in the background.
  //
  // We import lazily so the rest of the IPC layer can boot even if
  // playwright-core is missing (a packaging mistake or a stripped
  // distribution would otherwise crash the main process at module
  // load time, taking the whole app with it).
  ipcMain.handle('chrome:status', async () => {
    const { getStatus } = await import('./chromeBridge');
    return getStatus();
  });
  ipcMain.handle('chrome:connect', async (_e, port?: number) => {
    const { connect, getStatus } = await import('./chromeBridge');
    try {
      await connect(typeof port === 'number' ? port : undefined);
      // Sticky auto-reconnect: remember the port the user just
      // connected to. The next app start checks this setting from
      // `main.ts` and auto-reconnects in the background. The user's
      // explicit Connect click IS the opt-in — clicking Disconnect
      // clears the setting (see handler below) so they can turn it
      // off without any extra UI.
      setSetting(
        'chrome.autoConnectPort',
        String(typeof port === 'number' ? port : '')
      );
      return { ok: true, status: getStatus() };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.message ?? String(e),
        status: getStatus(),
      };
    }
  });
  ipcMain.handle('chrome:disconnect', async () => {
    const { disconnect, getStatus } = await import('./chromeBridge');
    await disconnect();
    // Clear the sticky-reconnect preference so the next app start
    // honors the user's "I want this off" intent. They can re-enable
    // by clicking Connect again.
    setSetting('chrome.autoConnectPort', '');
    return { ok: true, status: getStatus() };
  });

  // ---- Auto-updater --------------------------------------------------
  //
  // Bridges the renderer to electron-updater. The actual subsystem
  // is initialized in `main.ts` (it needs the BrowserWindow handle
  // for broadcasting events), but the IPC surface lives here.
  //
  // Lazy import: in dev mode, electron-updater can warn loudly about
  // missing manifest files even on module load. Dynamic import
  // inside the handlers means dev runs without those warnings unless
  // the user explicitly clicks "Check for updates."
  ipcMain.handle('update:status', async () => {
    const { getUpdateState } = await import('./autoUpdater');
    return getUpdateState();
  });
  ipcMain.handle('update:check', async () => {
    const { checkForUpdates } = await import('./autoUpdater');
    try {
      return await checkForUpdates();
    } catch (e: any) {
      // Re-shape into a structured response so the renderer can
      // distinguish "checked, no update" (returns state) from
      // "check itself errored" (rejected promise → error message).
      return {
        error: e?.message ?? String(e),
      };
    }
  });
  ipcMain.handle(
    'update:install',
    async (_evt, opts: { force?: boolean } = {}) => {
      const { installDownloadedUpdate, getUpdateState } = await import(
        './autoUpdater'
      );
      const { drainBeforeQuit, listActiveSessionIds } = await import(
        './quiesceManager'
      );
      const force = opts?.force === true;
      const startedAt = Date.now();
      if (force) {
        // Force-install path. The user has already seen a quiesce
        // timeout error and confirmed they want to drop in-flight
        // work. Abort each active session's run, then wait a short
        // grace period for the aborts to propagate and the row
        // states to settle. Whatever doesn't settle in 5 s gets
        // killed by the imminent `quitAndInstall` anyway, so there's
        // no point in waiting longer.
        const { cancelRun } = await import('./agent');
        const active = listActiveSessionIds();
        log.info(
          `[ipc:update:install] force-install requested with ${active.length} active session(s); aborting each`
        );
        for (const id of active) {
          try {
            cancelRun(id);
          } catch (e) {
            log.warn(`[ipc:update:install] cancelRun(${id}) threw`, e);
          }
        }
        // Short drain so the just-aborted sessions can transition to
        // idle/error and we can log how many actually cleaned up. If
        // some are still pinned (e.g. a tool ignoring the abort
        // signal — defense-in-depth: cancelRun has its own 5 s
        // watchdog that force-cleans `activeRuns`), we still install.
        try {
          await drainBeforeQuit({ timeoutMs: 5_000 });
        } catch (e: any) {
          log.warn(
            `[ipc:update:install] force-drain still found stuck sessions; installing anyway: ${e?.message ?? e}`
          );
        }
      } else {
        try {
          // Wait for in-flight agent turns to reach a quiescent state
          // (idle / waiting-on-user / sleeping-budget / error). Bounded
          // by the manager's own timeout (default 30 s) so a stuck tool
          // call can't permanently block the install.
          await drainBeforeQuit();
        } catch (e: any) {
          // Drain timed out — the renderer's UpdateBanner shows a
          // secondary "Force install anyway" button that re-calls
          // this handler with `{ force: true }`.
          return {
            ok: false,
            error: `quiesce timed out: ${e?.message ?? e}`,
            state: getUpdateState(),
          };
        }
      }
      const drainedAfterMs = Date.now() - startedAt;
      const ok = installDownloadedUpdate();
      if (!ok) {
        return {
          ok: false,
          error:
            'no update is downloaded yet — refresh status and try again',
          state: getUpdateState(),
          drainedAfterMs,
        };
      }
      // We never get here in practice — quitAndInstall terminates the
      // process — but the promise needs to resolve in case of a race.
      return { ok: true, drainedAfterMs };
    }
  );
}

/** Encode a Windows/Unix cwd path the same way Claude Code does. */
function projectIdFromCwd(cwd: string): string {
  return cwd.replace(/[\\:/]/g, '-');
}
