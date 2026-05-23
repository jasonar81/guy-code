import { create } from 'zustand';
import type {
  SessionRow,
  ImportProgress,
  ChatMessage,
  ContentBlock,
  AgentEvent,
  ApiKey,
} from '@/types';

export type SidebarFilter = 'active' | 'all' | 'archived';

const FILTER_STORAGE = 'guycode.sidebarFilter';

function readInitialFilter(): SidebarFilter {
  try {
    const v = localStorage.getItem(FILTER_STORAGE);
    if (v === 'active' || v === 'all' || v === 'archived') return v;
  } catch {
    /* ignore */
  }
  return 'active';
}

/** Per-session chat UI state, keyed by sessionId. */
interface SessionChat {
  messages: ChatMessage[];
  /**
   * Lookup table: tool_use id → its tool_result block. Maintained
   * incrementally — on every `tool_result` event we copy this Map and
   * insert the new entry, so unrelated MessageBlock components can use
   * `prev.resultsById === next.resultsById` to short-circuit memo and
   * skip re-render entirely. (Previously we re-walked the full message
   * list inside MessageList on every render to build this map fresh,
   * which made every text_delta O(N). For Channel Factory's thousands
   * of messages that pegged the renderer for minutes at a time and
   * caused IPC/click events to queue up behind React reconciliation.)
   */
  resultsById: Map<string, Extract<ContentBlock, { type: 'tool_result' }>>;
  /** True while a turn is in flight (between turn_start and turn_done). */
  streaming: boolean;
  /** Set when the model called WaitForUser; clears on next user message. */
  pendingQuestion: { id: string; question: string } | null;
  /** Last error string, if any. */
  errorMessage: string | null;
  /** Cost accumulated during the most recent turn (resets on next turn_start). */
  liveTurnCostMicros: number;
  /** Whether we've loaded prior history at least once. */
  loaded: boolean;
  /**
   * Mid-turn queued user messages: text the user typed while a turn was
   * already running. The agent loop drains them between tool rounds. We
   * track them locally so the composer can show "queued: 2" feedback and
   * so messages are visible to the user even before the agent picks them up.
   */
  pendingInterrupts: Array<{ localId: string; text: string; ts: number }>;
  /**
   * When non-null, the agent is between rounds: it's flushed a tool batch
   * and is now waiting on Anthropic's API to respond. With huge contexts
   * (700K+ tokens) this can be 10-60+ seconds of dead silence — the
   * Composer surfaces the elapsed time + estimated input tokens so the
   * user can tell the difference between "model is thinking" and "the
   * app hung". Cleared by `response_started`, `turn_done`, or `error`.
   */
  awaitingResponse: {
    startedAt: number;
    estimatedInputTokens: number;
    messageCount: number;
  } | null;
  /**
   * Most recent TodoWrite list issued by the model, surfaced as a
   * sticky panel above the message transcript. The visibility problem
   * we're solving: the model emits long PowerShell calls separated by
   * one-sentence narration like "now run the next benchmark", giving
   * the user no sense of how the current work fits into the larger
   * goal. By extracting and persistently displaying TodoWrite output
   * we keep the plan in view between rounds. Updated on `tool_use_done`
   * for TodoWrite, and reseeded on history load by walking messages
   * backward to find the latest TodoWrite tool_use input.
   */
  currentTodos: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }> | null;
}

const emptyChat = (): SessionChat => ({
  messages: [],
  resultsById: new Map(),
  streaming: false,
  pendingQuestion: null,
  errorMessage: null,
  liveTurnCostMicros: 0,
  loaded: false,
  pendingInterrupts: [],
  awaitingResponse: null,
  currentTodos: null,
});

type TodoItem = {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

/**
 * Walk the message list backward to find the most recent TodoWrite
 * tool_use, then return its `todos` array. Used on history load to
 * reseed `currentTodos` so the plan panel is populated immediately
 * after switching sessions or restarting the app.
 *
 * Returns null if no TodoWrite has been issued in this session.
 */
function findLatestTodos(messages: ChatMessage[]): TodoItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const b = m.content[j];
      if (b.type !== 'tool_use' || b.name !== 'TodoWrite') continue;
      const todos = (b.input as Record<string, unknown> | undefined)?.todos;
      if (Array.isArray(todos)) {
        // Coerce to our typed shape, dropping anything that doesn't look
        // like a valid todo. Keeps the panel resilient against partial /
        // malformed inputs (e.g. a streaming-truncated JSON that
        // happened to parse).
        const out: TodoItem[] = [];
        for (const t of todos) {
          if (!t || typeof t !== 'object') continue;
          const o = t as Record<string, unknown>;
          if (typeof o.id !== 'string') continue;
          if (typeof o.content !== 'string') continue;
          if (
            o.status !== 'pending' &&
            o.status !== 'in_progress' &&
            o.status !== 'completed'
          ) {
            continue;
          }
          out.push({ id: o.id, content: o.content, status: o.status });
        }
        return out.length > 0 ? out : null;
      }
    }
  }
  return null;
}

/**
 * Same shape coercion as `findLatestTodos`, but for a single tool_use
 * input as it lands via `tool_use_done`. Returns null only if the input
 * doesn't carry a usable todos array at all (e.g. JSON parse failed
 * mid-stream and the agent emitted an empty input). An EMPTY but
 * well-formed `todos: []` returns `[]`, which the reducer treats as
 * "clear the plan panel" — the model uses this to reset the slate
 * between unrelated tasks in the same session.
 */
function todosFromInput(input: unknown): TodoItem[] | null {
  const todos = (input as Record<string, unknown> | undefined)?.todos;
  if (!Array.isArray(todos)) return null;
  const out: TodoItem[] = [];
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    if (typeof o.id !== 'string') continue;
    if (typeof o.content !== 'string') continue;
    if (
      o.status !== 'pending' &&
      o.status !== 'in_progress' &&
      o.status !== 'completed'
    ) {
      continue;
    }
    out.push({ id: o.id, content: o.content, status: o.status });
  }
  // Return the (possibly empty) array — the reducer interprets [] as
  // "clear the panel". Only return null on truly malformed input where
  // we couldn't even parse the todos field.
  return out;
}

/**
 * Walk a freshly-loaded message list and build the tool_use_id → tool_result
 * lookup table. Used on initial history load. After that the reducer keeps
 * the table in sync incrementally on every `tool_result` event.
 */
function buildResultsById(
  messages: ChatMessage[]
): Map<string, Extract<ContentBlock, { type: 'tool_result' }>> {
  const map = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const b of m.content) {
      if (b.type === 'tool_result') map.set(b.tool_use_id, b);
    }
  }
  return map;
}

function localId(): string {
  return Math.random().toString(36).slice(2);
}

interface AppState {
  sessions: SessionRow[];
  activeSessionId: string | null;
  /** Set of session IDs that have ever been opened in this run — for pre-mount. */
  openedSessions: Set<string>;
  importProgress: ImportProgress | null;
  sidebarFilter: SidebarFilter;
  chats: Record<string, SessionChat>;
  hasApiKey: boolean | null;
  /** All configured API keys (no plaintext — preview only). */
  apiKeys: ApiKey[];
  /**
   * Which key the sidebar's BudgetPill is showing. null = aggregated
   * across all keys (legacy default). Otherwise an id from apiKeys.
   * Stored in localStorage so the user's preferred view survives
   * restarts.
   */
  budgetKeyFilter: string | null;

  setSessions: (s: SessionRow[]) => void;
  refreshSessions: () => Promise<void>;
  setActive: (id: string | null) => void;
  setImportProgress: (p: ImportProgress) => void;
  setSidebarFilter: (f: SidebarFilter) => void;
  rename: (id: string, title: string | null) => Promise<void>;
  setVisuals: (id: string, color: string | null, emoji: string | null) => Promise<void>;
  archive: (id: string, archived: boolean) => Promise<void>;
  /**
   * Permanently delete a session — removes the DB row AND the JSONL
   * file from disk. Destructive; the row will not come back even
   * after a re-import scan (unless the source JSONL still exists,
   * see deleteSession() doc in db.ts).
   */
  deleteFromDisk: (id: string) => Promise<void>;
  /**
   * Clear a queued (budget-paused) user message without auto-resuming.
   * Used by the "Cancel queued" button on the budget-sleep banner when
   * the user no longer wants the message to fire at the top of the
   * next hour.
   */
  cancelPending: (id: string) => Promise<void>;
  markIdle: (id: string) => Promise<void>;

  // Phase 2: chat
  loadHistory: (sessionId: string, fallbackPath?: string | null) => Promise<void>;
  sendMessage: (
    sessionId: string,
    text: string,
    attachments?: import('@/types').Attachment[]
  ) => Promise<void>;
  cancelTurn: (sessionId: string) => Promise<void>;
  /**
   * Queue text to be picked up by the running agent between tool rounds.
   * Use when the user types something during a turn — the agent grabs it on
   * the next iteration and inlines it into the conversation.
   */
  interruptTurn: (sessionId: string, text: string) => Promise<void>;
  /**
   * Remove a queued (not-yet-picked-up) interrupt by its localId. Used by
   * the X button on a queued bubble. We delete from local state first
   * (instant UI), then ask the main process to drop the matching backend
   * queue entry. Race tolerant: if the agent already drained between
   * click and IPC, the backend just returns removed=false.
   */
  removeInterrupt: (sessionId: string, localId: string) => Promise<void>;
  applyAgentEvent: (e: AgentEvent) => void;
  refreshHasApiKey: () => Promise<void>;
  createSession: (
    cwd: string,
    title?: string | null,
    apiKeyId?: string | null
  ) => Promise<string>;

  // ---- API keys ----
  refreshApiKeys: () => Promise<void>;
  createApiKey: (args: {
    name: string;
    plain: string;
    dailyBudgetUsd?: number | null;
    perTurnCapUsd?: number | null;
    setDefault?: boolean;
  }) => Promise<string | null>;
  updateApiKey: (
    id: string,
    patch: {
      name?: string;
      plain?: string;
      dailyBudgetUsd?: number | null;
      perTurnCapUsd?: number | null;
    }
  ) => Promise<boolean>;
  setDefaultApiKey: (id: string) => Promise<void>;
  deleteApiKey: (id: string) => Promise<void>;
  /**
   * Zero out a key's accumulated hourly carry-over (under/over-spend)
   * and re-anchor the adjustment clock to the current hour. Historical
   * spend totals are preserved; only the rolling adjustment is cleared.
   * Returns true when the main process confirmed the reset.
   */
  resetApiKeyBudgetAdjustment: (id: string) => Promise<boolean>;
  setSessionApiKey: (sessionId: string, apiKeyId: string | null) => Promise<void>;
  setBudgetKeyFilter: (apiKeyId: string | null) => void;
}

const BUDGET_FILTER_STORAGE = 'guycode.budgetKeyFilter';

function readInitialBudgetFilter(): string | null {
  try {
    const v = localStorage.getItem(BUDGET_FILTER_STORAGE);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export const useApp = create<AppState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  openedSessions: new Set(),
  importProgress: null,
  sidebarFilter: readInitialFilter(),
  chats: {},
  hasApiKey: null,
  apiKeys: [],
  budgetKeyFilter: readInitialBudgetFilter(),

  setSessions: (sessions) => set({ sessions }),

  refreshSessions: async () => {
    const sessions = await window.api.sessions.listAll();
    set({ sessions });
  },

  setActive: (id) => {
    if (!id) {
      set({ activeSessionId: null });
      return;
    }
    const opened = new Set(get().openedSessions);
    opened.add(id);
    set({ activeSessionId: id, openedSessions: opened });
  },

  setImportProgress: (importProgress) => {
    set({ importProgress });
    if (importProgress.phase === 'done') {
      get().refreshSessions();
    } else if (
      importProgress.phase === 'parse' &&
      importProgress.filesProcessed % 25 === 0
    ) {
      get().refreshSessions();
    }
  },

  setSidebarFilter: (sidebarFilter) => {
    try {
      localStorage.setItem(FILTER_STORAGE, sidebarFilter);
    } catch {
      /* ignore */
    }
    set({ sidebarFilter });
  },

  rename: async (id, title) => {
    const sessions = await window.api.sessions.rename(id, title);
    set({ sessions });
  },

  setVisuals: async (id, color, emoji) => {
    const sessions = await window.api.sessions.setVisuals(id, color, emoji);
    set({ sessions });
  },

  markIdle: async (id) => {
    const sessions = await window.api.sessions.setState(id, 'idle');
    set((s) => {
      const cur = s.chats[id];
      // Also clear any pending WaitForUser banner so the composer goes calm.
      const chats = cur
        ? { ...s.chats, [id]: { ...cur, pendingQuestion: null } }
        : s.chats;
      return { sessions, chats };
    });
  },

  deleteFromDisk: async (id) => {
    const sessions = await window.api.sessions.deleteFromDisk(id);
    set((s) => {
      const chats = { ...s.chats };
      delete chats[id];
      const opened = new Set(s.openedSessions);
      opened.delete(id);
      return {
        sessions,
        chats,
        openedSessions: opened,
        activeSessionId: s.activeSessionId === id ? null : s.activeSessionId,
      };
    });
  },

  cancelPending: async (id) => {
    const sessions = await window.api.sessions.cancelPending(id);
    set({ sessions });
  },

  archive: async (id, archived) => {
    const sessions = await window.api.sessions.archive(id, archived);
    set((s) => ({
      sessions,
      activeSessionId: s.activeSessionId === id && archived ? null : s.activeSessionId,
    }));
  },

  // ---- Phase 2: chat ----

  refreshHasApiKey: async () => {
    try {
      const ok = await window.api.secret.hasKey();
      set({ hasApiKey: ok });
    } catch {
      set({ hasApiKey: false });
    }
  },

  createSession: async (cwd, title, apiKeyId) => {
    const r = await window.api.sessions.create(
      cwd,
      title ?? null,
      apiKeyId ?? null
    );
    await get().refreshSessions();
    get().setActive(r.id);
    return r.id;
  },

  // ---- API keys ----

  refreshApiKeys: async () => {
    try {
      const apiKeys = await window.api.apiKeys.list();
      set({ apiKeys });
    } catch {
      /* ignore */
    }
  },

  createApiKey: async (args) => {
    const r = await window.api.apiKeys.create(args);
    set({ apiKeys: r.keys });
    // hasApiKey may flip true on first key create.
    if (r.ok) {
      const ok = await window.api.secret.hasKey();
      set({ hasApiKey: ok });
    }
    return r.id;
  },

  updateApiKey: async (id, patch) => {
    const r = await window.api.apiKeys.update(id, patch);
    set({ apiKeys: r.keys });
    return r.ok;
  },

  setDefaultApiKey: async (id) => {
    const apiKeys = await window.api.apiKeys.setDefault(id);
    set({ apiKeys });
  },

  deleteApiKey: async (id) => {
    const r = await window.api.apiKeys.delete(id);
    set((s) => ({
      apiKeys: r.keys,
      sessions: r.sessions,
      // If the active budget filter was on the deleted key, fall back
      // to "all keys" so the pill keeps working instead of showing
      // zeros for a key that no longer exists.
      budgetKeyFilter: s.budgetKeyFilter === id ? null : s.budgetKeyFilter,
    }));
    // First-key delete may flip hasApiKey false.
    const ok = await window.api.secret.hasKey();
    set({ hasApiKey: ok });
  },

  resetApiKeyBudgetAdjustment: async (id) => {
    const r = await window.api.apiKeys.resetBudgetAdjustment(id);
    set({ apiKeys: r.keys });
    return r.ok;
  },

  setSessionApiKey: async (sessionId, apiKeyId) => {
    const sessions = await window.api.sessions.setApiKey(sessionId, apiKeyId);
    set({ sessions });
  },

  setBudgetKeyFilter: (apiKeyId) => {
    try {
      // null means "All keys" — store as empty string so getItem can
      // distinguish "never set" (returns null) from "user picked all".
      // Reader treats both as null.
      localStorage.setItem(BUDGET_FILTER_STORAGE, apiKeyId ?? '');
    } catch {
      /* ignore */
    }
    set({ budgetKeyFilter: apiKeyId });
  },

  loadHistory: async (sessionId, fallbackPath) => {
    const cur = get().chats[sessionId];
    if (cur?.loaded) return;
    let raw: Awaited<ReturnType<typeof window.api.agent.loadMessages>> = [];
    try {
      raw = await window.api.agent.loadMessages(sessionId, {
        fallbackPath: fallbackPath ?? undefined,
      });
    } catch (err) {
      // IPC failure (e.g. main-process throw). Surface it to the chat panel
      // instead of silently leaving the session "empty" — empty looks the
      // same as a fresh session, so the bug is undetectable from the UI.
      console.error('[loadHistory] IPC failed', { sessionId, fallbackPath, err });
      set((s) => ({
        chats: {
          ...s.chats,
          [sessionId]: {
            ...(s.chats[sessionId] ?? emptyChat()),
            loaded: true,
            errorMessage: `Failed to load conversation history: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        },
      }));
      return;
    }
    const messages: ChatMessage[] = raw.map((m) => {
      const blocks = normalizeContent(m.content);
      return { localId: localId(), role: m.role, content: blocks, ts: m.ts ?? null };
    });
    // Build the tool_result lookup table once on load; thereafter the
    // reducer maintains it incrementally (see resultsById comment in
    // SessionChat). This keeps MessageList renders cheap even for
    // thousands of historical messages.
    const resultsById = buildResultsById(messages);
    // Reseed the persistent plan panel from the most recent TodoWrite
    // in history so the user sees their goal immediately on session
    // switch / app restart, not just after the next live tool call.
    const currentTodos = findLatestTodos(messages);
    set((s) => ({
      chats: {
        ...s.chats,
        [sessionId]: {
          ...(s.chats[sessionId] ?? emptyChat()),
          messages,
          resultsById,
          currentTodos,
          loaded: true,
        },
      },
    }));
  },

  sendMessage: async (sessionId, text, attachments) => {
    const sess = get().sessions.find((s) => s.id === sessionId);
    if (!sess) return;
    // Empty string = no cwd binding; backend tools fall back to HOME.
    const cwd = sess.cwd ?? '';
    // Locally append immediately so the user sees their message right away,
    // including any attached images / documents in the bubble. We mirror the
    // Anthropic content-block layout: text first, then attachments.
    const localBlocks: ContentBlock[] = [];
    if (text) localBlocks.push({ type: 'text', text });
    for (const a of attachments ?? []) {
      if (a.kind === 'image') {
        localBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: a.mediaType, data: a.dataBase64 },
          name: a.name,
        });
      } else if (a.kind === 'pdf') {
        localBlocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: a.dataBase64 },
          name: a.name,
        });
      } else if (a.kind === 'text') {
        // Inline plain-text attachments as fenced code blocks so the agent
        // sees them as content (no separate "document" block needed).
        localBlocks.push({
          type: 'text',
          text: `\n\n--- Attached: ${a.name} ---\n${a.text}\n--- end ${a.name} ---`,
        });
      }
    }
    if (localBlocks.length === 0) return; // nothing to send
    set((s) => {
      const cur = s.chats[sessionId] ?? emptyChat();
      const messages = [
        ...cur.messages,
        {
          localId: localId(),
          role: 'user' as const,
          content: localBlocks,
          ts: Date.now(),
        },
      ];
      return {
        chats: {
          ...s.chats,
          [sessionId]: {
            ...cur,
            messages,
            streaming: true,
            pendingQuestion: null,
            errorMessage: null,
            liveTurnCostMicros: 0,
            loaded: true,
          },
        },
      };
    });
    await window.api.agent.run({
      sessionId,
      projectId: sess.project_id,
      cwd,
      userText: text,
      attachments,
      seedFromJsonl: sess.jsonl_path,
    });
  },

  cancelTurn: async (sessionId) => {
    await window.api.agent.cancel(sessionId);
  },

  interruptTurn: async (sessionId, text) => {
    const t = text.trim();
    if (!t) return;
    // Optimistically show the user's typed text immediately as a pending
    // interrupt. When the agent loop drains it (interrupt_picked_up event),
    // we promote it to a real user message in `applyAgentEvent`.
    const pid = localId();
    set((s) => {
      const cur = s.chats[sessionId] ?? emptyChat();
      return {
        chats: {
          ...s.chats,
          [sessionId]: {
            ...cur,
            pendingInterrupts: [
              ...cur.pendingInterrupts,
              { localId: pid, text: t, ts: Date.now() },
            ],
          },
        },
      };
    });
    await window.api.agent.interrupt(sessionId, t);
  },

  removeInterrupt: async (sessionId, localIdToRemove) => {
    const cur = get().chats[sessionId];
    if (!cur) return;
    const target = cur.pendingInterrupts.find((p) => p.localId === localIdToRemove);
    if (!target) return;
    // Optimistic local removal so the bubble disappears instantly. If the
    // backend has already drained, we'll receive an interrupt_picked_up
    // event but our findIndex(text) will miss; the message just gets
    // re-added as a regular user bubble. That's acceptable graceful behavior.
    set((s) => {
      const c = s.chats[sessionId];
      if (!c) return s;
      return {
        chats: {
          ...s.chats,
          [sessionId]: {
            ...c,
            pendingInterrupts: c.pendingInterrupts.filter(
              (p) => p.localId !== localIdToRemove
            ),
          },
        },
      };
    });
    await window.api.agent.removeInterrupt(sessionId, target.text);
  },

  applyAgentEvent: (e) =>
    set((s) => {
      const sid = e.sessionId;
      const cur = s.chats[sid] ?? emptyChat();
      const next = { ...cur };
      switch (e.type) {
        case 'turn_start': {
          next.streaming = true;
          next.pendingQuestion = null;
          next.errorMessage = null;
          next.liveTurnCostMicros = 0;
          // Normally sendMessage() pre-appended the user message. But the
          // budget governor's auto-resume path skips that and goes straight
          // to runUserTurn — so the user message would be missing from the
          // chat unless we add it here.
          const last = next.messages[next.messages.length - 1];
          const alreadyThere =
            last &&
            last.role === 'user' &&
            last.content.some(
              (b) => b.type === 'text' && b.text === e.userText
            );
          if (!alreadyThere && e.userText) {
            next.messages = [
              ...next.messages,
              {
                localId: localId(),
                role: 'user' as const,
                content: [{ type: 'text' as const, text: e.userText }],
                ts: Date.now(),
              },
            ];
          }
          break;
        }
        case 'text_delta': {
          const msgs = ensureStreamingAssistant(next.messages);
          const last = msgs[msgs.length - 1];
          let lastBlock = last.content[last.content.length - 1];
          if (!lastBlock || lastBlock.type !== 'text') {
            lastBlock = { type: 'text', text: '' };
            last.content = [...last.content, lastBlock];
          } else {
            // immutable: replace the block
            const updated: ContentBlock = { type: 'text', text: lastBlock.text + e.text };
            last.content = [...last.content.slice(0, -1), updated];
          }
          // last.content already updated; if we created the block above, also patch text
          if (last.content[last.content.length - 1].type === 'text') {
            const tb = last.content[last.content.length - 1] as { type: 'text'; text: string };
            if (!tb.text) tb.text = e.text;
            else if (lastBlock && (lastBlock as any).text === '') tb.text = e.text;
          }
          next.messages = msgs;
          break;
        }
        case 'tool_use_start': {
          const msgs = ensureStreamingAssistant(next.messages);
          const last = msgs[msgs.length - 1];
          last.content = [
            ...last.content,
            { type: 'tool_use', id: e.id, name: e.name, input: {}, partialInput: '' },
          ];
          next.messages = msgs;
          break;
        }
        case 'tool_use_input_delta': {
          // Same memo-friendliness rule as text_delta: the streaming
          // tail message must get a fresh object identity so memoized
          // MessageBlocks notice the change. We clone via
          // ensureStreamingAssistant rather than the previous in-place
          // mutation that left `last`'s ref unchanged.
          const msgs = ensureStreamingAssistant(next.messages);
          const last = msgs[msgs.length - 1];
          if (last.role === 'assistant') {
            last.content = last.content.map((b) => {
              if (b.type === 'tool_use' && b.id === e.id) {
                return { ...b, partialInput: (b.partialInput ?? '') + e.partial };
              }
              return b;
            });
          }
          next.messages = msgs;
          break;
        }
        case 'tool_use_done': {
          const msgs = ensureStreamingAssistant(next.messages);
          const last = msgs[msgs.length - 1];
          if (last.role === 'assistant') {
            last.content = last.content.map((b) => {
              if (b.type === 'tool_use' && b.id === e.id) {
                return { ...b, input: e.input, partialInput: undefined };
              }
              return b;
            });
          }
          next.messages = msgs;
          // TodoWrite is the model's plan-update mechanism. Refresh the
          // persistent plan panel here so the user sees the new state
          // immediately, not after the tool round-trip completes.
          if (e.name === 'TodoWrite') {
            const todos = todosFromInput(e.input);
            // `null` → malformed input, leave panel unchanged.
            // `[]`   → model explicitly cleared the plan; null out so the
            //          panel hides until the next TodoWrite.
            // `[…]`  → wholesale replacement of the plan.
            if (todos !== null) {
              next.currentTodos = todos.length > 0 ? todos : null;
            }
          }
          break;
        }
        case 'tool_result': {
          // Append a user message containing the tool_result block. We
          // keep this representation (rather than embedding the result
          // inline on the tool_use) because it mirrors the Anthropic
          // wire format that's persisted to JSONL and re-loaded later.
          const resultBlock: Extract<ContentBlock, { type: 'tool_result' }> = {
            type: 'tool_result',
            tool_use_id: e.id,
            content: e.content,
            is_error: e.isError,
            ms: e.ms,
          };
          next.messages = [
            ...next.messages,
            {
              localId: localId(),
              role: 'user',
              content: [resultBlock],
              ts: Date.now(),
            },
          ];
          // Maintain the lookup table incrementally so MessageList can
          // skip re-walking history. New Map ref signals to memoized
          // MessageBlocks that *something* changed; their custom
          // comparator then checks whether any of THIS message's
          // tool_use ids now resolve to a different tool_result, and
          // re-renders only the affected message.
          const resultsById = new Map(next.resultsById);
          resultsById.set(e.id, resultBlock);
          next.resultsById = resultsById;
          break;
        }
        case 'usage':
          next.liveTurnCostMicros = next.liveTurnCostMicros + e.costUsdMicros;
          // refresh sidebar costs asynchronously
          setTimeout(() => get().refreshSessions(), 0);
          break;
        case 'wait_for_user':
          next.pendingQuestion = { id: e.id, question: e.question };
          break;
        case 'interrupt_picked_up': {
          // The agent loop drained one of our queued interrupts and is
          // injecting it into the next user message. Promote it from the
          // local "pending" list into a real user bubble so the transcript
          // shows it at exactly the point in time the model received it.
          const idx = next.pendingInterrupts.findIndex((p) => p.text === e.text);
          if (idx >= 0) {
            next.pendingInterrupts = [
              ...next.pendingInterrupts.slice(0, idx),
              ...next.pendingInterrupts.slice(idx + 1),
            ];
          }
          next.messages = [
            ...next.messages,
            {
              localId: localId(),
              role: 'user',
              content: [{ type: 'text', text: e.text }],
              ts: Date.now(),
            },
          ];
          break;
        }
        case 'awaiting_response': {
          // Round boundary: agent has flushed any tool batch and is
          // waiting on the API. Composer renders "thinking… (Xs)" off
          // this state so the user can see something is happening.
          next.awaitingResponse = {
            startedAt: Date.now(),
            estimatedInputTokens: e.estimatedInputTokens,
            messageCount: e.messageCount,
          };
          break;
        }
        case 'response_started': {
          // First token / tool-use block landed — switch back to
          // normal streaming display.
          next.awaitingResponse = null;
          break;
        }
        case 'turn_done': {
          next.streaming = false;
          next.awaitingResponse = null;
          // mark last assistant message non-streaming
          const msgs = next.messages.slice();
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant' && msgs[i].streaming) {
              msgs[i] = { ...msgs[i], streaming: false, stopReason: e.stopReason };
              break;
            }
          }
          next.messages = msgs;
          // Safety-net plan-panel reseed. Normally the panel updates
          // live via tool_use_done events as TodoWrite calls land,
          // but rare cases (cancelled stream, partial-JSON parse
          // failure, race during fast tool batches) can leave the
          // panel stale. After every turn we re-walk the (now
          // final) message list to make sure currentTodos matches
          // the actual latest TodoWrite in history.
          const refreshedTodos = findLatestTodos(msgs);
          if (refreshedTodos) next.currentTodos = refreshedTodos;
          // refresh after stream completes to reflect server cost truth
          setTimeout(() => get().refreshSessions(), 0);
          break;
        }
        case 'error':
          next.streaming = false;
          next.awaitingResponse = null;
          next.errorMessage = e.message;
          break;
        case 'state_changed': {
          // Patch the session row in place so the sidebar reflects the new
          // state without a full reload (avoids re-sorting 300 sessions).
          const sessions = s.sessions.map((row) =>
            row.id === sid ? { ...row, state: e.state } : row
          );
          return { sessions, chats: { ...s.chats, [sid]: next } };
        }
        case 'budget_blocked': {
          next.streaming = false;
          const spent = (e.spentMicros / 1_000_000).toFixed(2);
          const cap = (e.capMicros / 1_000_000).toFixed(2);
          // Hourly buckets refill at the top of the next clock hour.
          const now = new Date();
          const nextHour = new Date(now);
          nextHour.setHours(now.getHours() + 1, 0, 0, 0);
          const wakeStr = nextHour.toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          });
          next.errorMessage = `Paused — this hour's spend $${spent} ≥ cap $${cap}. Auto-resumes at ${wakeStr}, or hit Force resume to bypass for one turn.`;
          // Refresh the sessions list so the renderer picks up the
          // newly-saved pending_user_text and sleeping_since columns —
          // that's what powers the "queued reply" bubble in the chat.
          // Without this, the bubble only appears after the next poll
          // (could be seconds), or worse, after the user navigates
          // away and back.
          setTimeout(() => get().refreshSessions(), 0);
          break;
        }
        case 'budget_woke': {
          // Just re-fetch sessions; row state will move out of sleeping-budget.
          setTimeout(() => get().refreshSessions(), 0);
          break;
        }
      }
      return { chats: { ...s.chats, [sid]: next } };
    }),
}));

// ---- helpers ----

/**
 * Ensure the last message is a streaming assistant message AND that it has
 * a fresh object identity. The reducer paths that follow this call mutate
 * the last message's `content` to apply text / tool_use / tool_use_input
 * deltas; if we reused the existing object reference, memoized
 * `MessageBlock` would compare `prev.message === next.message`, see the
 * same ref, and skip re-render — so the streaming text would never appear.
 *
 * Always returns:
 *   - a NEW outer array (so reference equality on `messages` flips)
 *   - a NEW last-message object (so memo's identity check fires for the
 *     streaming tail)
 *   - the SAME object refs for every prior message (so memo skips them)
 *
 * This is the hot path during streaming. For 35K-message sessions the
 * outer array clone is ~microseconds; the per-message render cost saving
 * is what makes the renderer responsive.
 */
function ensureStreamingAssistant(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && last.streaming) {
    // Clone array AND the tail message; the caller is about to mutate
    // its `content`. Keep `content` referencing the same array — the
    // reducer reassigns it to a fresh array on each delta.
    const next = messages.slice();
    next[next.length - 1] = { ...last };
    return next;
  }
  return [
    ...messages,
    {
      localId: localId(),
      role: 'assistant',
      content: [],
      streaming: true,
      ts: Date.now(),
    },
  ];
}

function normalizeContent(c: unknown): ContentBlock[] {
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  if (!Array.isArray(c)) return [];
  const out: ContentBlock[] = [];
  for (const b of c as any[]) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') {
      out.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
    } else if (b.type === 'tool_result') {
      const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      out.push({
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content,
        is_error: !!b.is_error,
      });
    } else if (
      b.type === 'image' &&
      b.source?.type === 'base64' &&
      typeof b.source.data === 'string'
    ) {
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: b.source.media_type ?? 'image/png',
          data: b.source.data,
        },
        name: typeof b.name === 'string' ? b.name : undefined,
      });
    } else if (
      b.type === 'document' &&
      b.source?.type === 'base64' &&
      typeof b.source.data === 'string'
    ) {
      out.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: b.source.media_type ?? 'application/pdf',
          data: b.source.data,
        },
        name: typeof b.name === 'string' ? b.name : undefined,
      });
    }
  }
  return out;
}
