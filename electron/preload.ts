import { contextBridge, ipcRenderer } from 'electron';

const api = {
  sessions: {
    listAll: () => ipcRenderer.invoke('sessions:listAll'),
    create: (cwd: string, title?: string | null, apiKeyId?: string | null) =>
      ipcRenderer.invoke('sessions:create', { cwd, title, apiKeyId }),
    rename: (id: string, title: string | null) =>
      ipcRenderer.invoke('sessions:rename', id, title),
    setVisuals: (id: string, color: string | null, emoji: string | null) =>
      ipcRenderer.invoke('sessions:setVisuals', id, color, emoji),
    archive: (id: string, archived: boolean) =>
      ipcRenderer.invoke('sessions:archive', id, archived),
    deleteFromDisk: (id: string) =>
      ipcRenderer.invoke('sessions:deleteFromDisk', id),
    setState: (id: string, state: string) =>
      ipcRenderer.invoke('sessions:setState', id, state),
    setDraft: (id: string, draft: string | null) =>
      ipcRenderer.invoke('sessions:setDraft', id, draft),
    cancelPending: (id: string) =>
      ipcRenderer.invoke('sessions:cancelPending', id),
    setApiKey: (id: string, apiKeyId: string | null) =>
      ipcRenderer.invoke('sessions:setApiKey', id, apiKeyId),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    listSessions: (projectId: string) =>
      ipcRenderer.invoke('projects:listSessions', projectId),
    rename: (id: string, name: string | null) =>
      ipcRenderer.invoke('projects:rename', id, name),
    setVisuals: (id: string, color: string | null, emoji: string | null) =>
      ipcRenderer.invoke('projects:setVisuals', id, color, emoji),
    archive: (id: string, archived: boolean) =>
      ipcRenderer.invoke('projects:archive', id, archived),
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    list: () => ipcRenderer.invoke('settings:list'),
  },
  audit: {
    list: (opts?: { sessionId?: string; limit?: number; beforeId?: number | null }) =>
      ipcRenderer.invoke('audit:list', opts),
  },
  budget: {
    status: (apiKeyId?: string | null) =>
      ipcRenderer.invoke('budget:status', apiKeyId ?? null),
    forceResume: (sessionId: string) =>
      ipcRenderer.invoke('budget:forceResume', sessionId),
  },
  apiKeys: {
    list: () => ipcRenderer.invoke('apiKeys:list'),
    create: (args: {
      name: string;
      plain: string;
      dailyBudgetUsd?: number | null;
      perTurnCapUsd?: number | null;
      setDefault?: boolean;
      // Per-key active-hours window for budget redistribution. Both
      // integers in [0..23]; equal values (including the 0/0 default)
      // mean "all 24 hours active" — identical to v0.1.3 behavior.
      // When start > end the window wraps midnight (e.g. 22..6).
      // Outside the window the per-hour base is 0; carry-over flows
      // through. See `electron/budget.ts` for the math.
      activeHourStart?: number;
      activeHourEnd?: number;
    }) => ipcRenderer.invoke('apiKeys:create', args),
    update: (
      id: string,
      patch: {
        name?: string;
        plain?: string;
        dailyBudgetUsd?: number | null;
        perTurnCapUsd?: number | null;
        activeHourStart?: number;
        activeHourEnd?: number;
      }
    ) => ipcRenderer.invoke('apiKeys:update', id, patch),
    setDefault: (id: string) => ipcRenderer.invoke('apiKeys:setDefault', id),
    delete: (id: string) => ipcRenderer.invoke('apiKeys:delete', id),
    // Zero accumulated carry-over (underages/overages) for one key.
    // Wired to the per-key "Reset overages/underages" button in Settings.
    resetBudgetAdjustment: (id: string) =>
      ipcRenderer.invoke('apiKeys:resetBudgetAdjustment', id),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    signIn: (name: string) => ipcRenderer.invoke('mcp:signIn', name),
    signOut: (name: string) => ipcRenderer.invoke('mcp:signOut', name),
  },
  skills: {
    // Returns { skills: [{ name, description, source }] } for a cwd.
    // Used by the Composer's slash-command autocomplete menu.
    list: (cwd: string | null) => ipcRenderer.invoke('skills:list', cwd),
  },
  imports: {
    run: () => ipcRenderer.invoke('import:run'),
    onProgress: (cb: (p: any) => void) => {
      const listener = (_: unknown, p: any) => cb(p);
      ipcRenderer.on('import:progress', listener);
      return () => ipcRenderer.removeListener('import:progress', listener);
    },
  },
  secret: {
    hasKey: () => ipcRenderer.invoke('secret:hasKey'),
    setKey: (key: string) => ipcRenderer.invoke('secret:setKey', key),
  },
  dialog: {
    pickDirectory: (defaultPath?: string) =>
      ipcRenderer.invoke('dialog:pickDirectory', { defaultPath }),
  },
  chrome: {
    // Returns the connector's current state: {status, port, error,
    // connectedAt, tabCount}. The Settings UI polls this while open so
    // the user sees the indicator flip when they launch / kill Chrome.
    status: () => ipcRenderer.invoke('chrome:status'),
    // Resolves with {ok, status} on success or {ok:false, error, status}
    // on failure (e.g. Chrome not listening on the port). The renderer
    // surfaces `error` verbatim because the main side already wrote a
    // user-actionable message.
    connect: (port?: number) => ipcRenderer.invoke('chrome:connect', port),
    disconnect: () => ipcRenderer.invoke('chrome:disconnect'),
  },
  agent: {
    loadMessages: (sessionId: string, opts?: { fallbackPath?: string }) =>
      ipcRenderer.invoke('agent:loadMessages', sessionId, opts),
    run: (args: {
      sessionId: string;
      projectId: string;
      cwd: string;
      userText: string;
      attachments?: unknown[];
      seedFromJsonl?: string | null;
    }) => ipcRenderer.invoke('agent:run', args),
    cancel: (sessionId: string) => ipcRenderer.invoke('agent:cancel', sessionId),
    interrupt: (sessionId: string, text: string) =>
      ipcRenderer.invoke('agent:interrupt', sessionId, text),
    removeInterrupt: (sessionId: string, text: string) =>
      ipcRenderer.invoke('agent:removeInterrupt', sessionId, text),
    isRunning: (sessionId: string) => ipcRenderer.invoke('agent:isRunning', sessionId),
    onEvent: (cb: (e: any) => void) => {
      const listener = (_: unknown, e: any) => cb(e);
      ipcRenderer.on('agent:event', listener);
      return () => ipcRenderer.removeListener('agent:event', listener);
    },
  },
  update: {
    // Snapshot of the auto-updater state machine. The Settings
    // panel reads this on mount; the UpdateBanner relies on the
    // streaming `onEvent` subscription below for live updates.
    status: () => ipcRenderer.invoke('update:status'),
    // Manual "Check for updates" button. Resolves with the
    // post-check state snapshot. Errors propagate as a thrown
    // exception (caller's catch sees the message).
    check: () => ipcRenderer.invoke('update:check'),
    // Triggers `quitAndInstall` AFTER the quiesce manager confirms
    // sessions are drained. Returns { ok, error?, drainedAfterMs? }.
    //
    // Pass `{ force: true }` to bypass the drain wait: the IPC
    // handler aborts every active session, gives them a 5 s grace
    // window to settle, then installs regardless. The renderer only
    // surfaces the Force button after the non-force install path
    // already returned a quiesce-timeout error.
    install: (opts: { force?: boolean } = {}) =>
      ipcRenderer.invoke('update:install', opts),
    // Subscribe to every state transition (checking, available,
    // downloaded, error, etc.). Returns an unsubscribe thunk so
    // React effects can clean up on unmount.
    onEvent: (cb: (state: unknown) => void) => {
      const listener = (_: unknown, state: unknown) => cb(state);
      ipcRenderer.on('update:event', listener);
      return () => ipcRenderer.removeListener('update:event', listener);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

export type GuyCodeApi = typeof api;
