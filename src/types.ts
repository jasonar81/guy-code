export type ProjectState =
  | 'idle'
  | 'running'
  | 'waiting-on-system'
  | 'waiting-on-user'
  | 'error'
  | 'sleeping-budget'
  | 'sleeping-tool';

/** Each row in the sidebar. One JSONL = one session = one row. */
export interface SessionRow {
  id: string;
  project_id: string;
  jsonl_path: string;
  jsonl_mtime: number;
  jsonl_size: number;
  started_at: number | null;
  ended_at: number | null;
  message_count: number;
  last_message_preview: string | null;
  title: string | null;        // auto-generated from first user msg
  user_title: string | null;   // user-set, takes precedence
  color: string | null;
  emoji: string | null;
  state: ProjectState;
  archived: number;
  cwd: string | null;
  cost_all_time_micros: number;
  cost_24h_micros: number;
  /** User message queued while the session was paused for budget. */
  pending_user_text: string | null;
  /** When the session entered sleeping-budget; null otherwise. */
  sleeping_since: number | null;
  /**
   * Wall-clock ms-epoch at which a `sleeping-tool` session resumes
   * (today: `WaitForTime`). Null when not sleeping. The sidebar uses
   * this to render "Sleeps until 2:14 PM" without round-tripping.
   */
  wake_at_ts: number | null;
  /**
   * Per-session draft text (the unsubmitted message in the composer).
   * Survives app restart so the user's in-progress typing isn't lost.
   * The Composer hydrates its initial textarea state from this on
   * first mount and writes back via `setSessionDraft` (debounced).
   * Cleared on successful send. NULL = no draft.
   */
  draft_text: string | null;
  /** API key id this session is bound to. Null = inherits the current default. */
  api_key_id: string | null;
}

/**
 * One API key entry as the renderer sees it. The plaintext is NEVER sent
 * over IPC — only a short `preview` (first/last few chars) so the user
 * can visually distinguish multiple sk-ant-...xyz entries.
 */
export interface ApiKey {
  id: string;
  name: string;
  daily_budget_usd: number | null;
  per_turn_cap_usd: number | null;
  is_default: boolean;
  created_at: number;
  preview: string | null;
  /**
   * Active-hours window for budget redistribution. Both integers in
   * [0..23]. When `active_hour_start == active_hour_end` (including
   * the 0/0 default) the budget spreads over all 24 hours —
   * identical to v0.1.3 and earlier behavior. Otherwise the window
   * is the half-open interval [start, end) per local clock, wrapping
   * midnight when end < start. Outside the window the per-hour base
   * is zero but the carry-over adjustment still flows through.
   */
  active_hour_start: number;
  active_hour_end: number;
}

export interface ProjectRow {
  id: string;
  cwd: string;
  user_name: string | null;
  color: string | null;
  emoji: string | null;
  state: ProjectState;
  archived: number;
  last_activity_ts: number | null;
  created_at: number;
  cost_all_time_micros: number;
  cost_24h_micros: number;
  session_count: number;
  last_session_preview: string | null;
}

/** A single content block as we render it (closely mirrors Anthropic's shape). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      /** Local-only: incremental input JSON during stream. */
      partialInput?: string;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      /** Local-only: ms taken to execute. */
      ms?: number;
    }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
        data: string;
      };
      /** Local-only: optional original filename to show in the bubble. */
      name?: string;
    }
  | {
      type: 'document';
      source: {
        type: 'base64';
        media_type: 'application/pdf';
        data: string;
      };
      /** Local-only: optional original filename to show in the bubble. */
      name?: string;
    };

/**
 * Attachment shape used by the composer/IPC. Distinct from `ContentBlock`
 * because we want a flat structure for the file picker / paste pipeline,
 * with a single `kind` discriminator and friendly metadata. The agent
 * runtime translates these into Anthropic content blocks at send time.
 */
export type Attachment =
  | {
      kind: 'image';
      name: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
      dataBase64: string;
      sizeBytes: number;
    }
  | {
      kind: 'pdf';
      name: string;
      dataBase64: string;
      sizeBytes: number;
    }
  | {
      kind: 'text';
      name: string;
      text: string;
      sizeBytes: number;
    }
  /**
   * Disk-backed text attachment for files too large to inline directly
   * into the prompt (>200KB by default; see `INLINE_TEXT_THRESHOLD` in
   * `Composer.tsx`). The renderer hands the full text to the main
   * process, which writes it under
   * `~/.guycode/attachments/<sessionId>/<name>` and emits a reference
   * content block that points the model at the absolute path. The
   * model accesses the contents via the existing `Read` tool, so any
   * file size up to `MAX_TEXT_FILE_BYTES` (50MB) works without
   * burning prompt tokens proportional to size.
   *
   * `text` carries the full content over IPC — main writes it; the
   * renderer keeps it in state so the chip preview / future re-sends
   * still work. We never persist this kind into the JSONL with the
   * full text inline (the JSONL stores the reference block only).
   */
  | {
      kind: 'text-file';
      name: string;
      text: string;
      sizeBytes: number;
    }
  /**
   * Rich document that needs server-side (main-process) text extraction:
   * Office Open XML (Word .docx, Excel .xlsx, PowerPoint .pptx) and Rich
   * Text Format (.rtf). The renderer ships the raw file bytes as base64;
   * the main process extracts plain text (see `electron/office.ts` and
   * `electron/rtf.ts`), writes the extracted text under
   * `~/.guycode/attachments/<sessionId>/` as a `.txt`, and emits the same
   * disk-backed reference block as `text-file`.
   *
   * Why base64 of the original bytes (not pre-extracted text in the
   * renderer): the office extraction depends on `fflate` (a main-process
   * dependency) and the parsers live in `electron/`. Doing it in the
   * renderer would mean bundling those into the web build and trusting
   * renderer-side parsing of untrusted file bytes. Keeping extraction in
   * main matches where the disk-write already happens and keeps the
   * renderer thin. RTF rides the same path for consistency even though
   * it's technically text.
   *
   * `docKind` tells main which extractor to run.
   * `sizeBytes` is the original file size (for the chip + cap checks).
   */
  | {
      kind: 'rich-doc';
      name: string;
      docKind: 'docx' | 'xlsx' | 'pptx' | 'rtf';
      dataBase64: string;
      sizeBytes: number;
    };

export interface ChatMessage {
  /** Stable id for React keying. */
  localId: string;
  role: 'user' | 'assistant';
  content: ContentBlock[];
  /** Wall-clock ms epoch when this message was created/received. */
  ts: number | null;
  /** True while the model is streaming this message. */
  streaming?: boolean;
  /** For assistant turns, captured at message_stop. */
  stopReason?: string | null;
}

export type AgentEvent =
  | { type: 'turn_start'; sessionId: string; userText: string }
  | { type: 'text_delta'; sessionId: string; text: string }
  | { type: 'tool_use_start'; sessionId: string; id: string; name: string }
  | { type: 'tool_use_input_delta'; sessionId: string; id: string; partial: string }
  | { type: 'tool_use_done'; sessionId: string; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      sessionId: string;
      id: string;
      content: string;
      isError: boolean;
      ms: number;
    }
  | { type: 'usage'; sessionId: string; costUsdMicros: number; usage: any }
  | { type: 'wait_for_user'; sessionId: string; id: string; question: string }
  | { type: 'turn_done'; sessionId: string; stopReason: string | null }
  | { type: 'interrupt_picked_up'; sessionId: string; text: string }
  | { type: 'state_changed'; sessionId: string; state: ProjectState }
  | {
      type: 'budget_blocked';
      sessionId: string;
      reason: string;
      capMicros: number;
      spentMicros: number;
    }
  | { type: 'budget_woke'; sessionId: string }
  | {
      type: 'awaiting_response';
      sessionId: string;
      estimatedInputTokens: number;
      messageCount: number;
    }
  | { type: 'response_started'; sessionId: string; latencyMs: number }
  | { type: 'error'; sessionId: string; message: string };

export interface AuditEventRow {
  id: number;
  ts: number;
  project_id: string;
  session_id: string | null;
  tool: string;
  input_json: string | null;
  output_ref: string | null;
  status: string;
  duration_ms: number | null;
}

/**
 * Slim skill summary surfaced to the renderer for the slash-command
 * autocomplete menu. Bodies stay on the main side — they're large
 * and only the model needs them (via the Skill tool).
 */
export interface SkillSummary {
  name: string;
  description: string;
  /**
   * Where this skill came from. Determines the sort/badge in the
   * autocomplete menu so the user can tell at a glance whether they're
   * picking a Guy-native skill, a Claude-imported one, etc.
   */
  source: 'guy-user' | 'guy-project' | 'claude-user' | 'claude-project' | 'claude-commands';
}

export interface McpServerStatus {
  name: string;
  status: 'connected' | 'needs-auth' | 'error' | 'disabled' | 'connecting';
  toolCount: number;
  error?: string;
  needsOAuth: boolean;
  source: string;
  /** Tool names exposed by this server (only when connected). */
  toolNames: string[];
  /** OAuth scope configured in `.mcp.json`, if any. */
  configuredScope?: string;
}

export interface BudgetStatus {
  /** Which key this status is scoped to. Null = aggregated across all keys. */
  apiKeyId?: string | null;
  /**
   * Hourly cap in micros (= daily / 24) for the selected key, or null
   * when uncapped (governor disabled). This is the cap the governor
   * actually enforces. The pre-flight check fires when
   * `hourSpentMicros + reservations >= hourCapMicros` AND the session
   * has already taken a turn this hour.
   */
  hourCapMicros: number | null;
  /** Current clock-hour spend on this key (excludes in-flight reservations). */
  hourSpentMicros: number;
  /**
   * Daily budget in micros for the selected key, or null when
   * uncapped. Informational — the human-facing knob; enforcement is
   * hourly.
   */
  dailyCapMicros: number | null;
  /** Today's spend (local-day) on this key — informational. */
  daySpentMicros: number;
  /**
   * Rolling 24-hour spend for the selected key. Surfaced for the
   * "no budget configured" fallback so users still see recent
   * activity in the sidebar pill even when the governor isn't gating
   * anything.
   */
  last24hSpentMicros: number;
}

export interface ImportProgress {
  phase: 'scan' | 'parse' | 'done' | 'error';
  filesTotal: number;
  filesProcessed: number;
  bytesProcessed: number;
  newUsageEvents: number;
  newSessions: number;
  newProjects: number;
  currentPath?: string;
  error?: string;
}

declare global {
  interface Window {
    api: {
      app: {
        /**
         * The version string `app.getVersion()` returns. For released
         * builds this matches the GitHub release tag exactly because
         * the CI workflow pins package.json's version field from the
         * tag before electron-builder runs.
         */
        version: () => Promise<string>;
      };
      sessions: {
        listAll: () => Promise<SessionRow[]>;
        create: (
          cwd: string,
          title?: string | null,
          apiKeyId?: string | null
        ) => Promise<{
          id: string;
          projectId: string;
          cwd: string;
          apiKeyId: string | null;
        }>;
        rename: (id: string, title: string | null) => Promise<SessionRow[]>;
        setVisuals: (
          id: string,
          color: string | null,
          emoji: string | null
        ) => Promise<SessionRow[]>;
        archive: (id: string, archived: boolean) => Promise<SessionRow[]>;
        deleteFromDisk: (id: string) => Promise<SessionRow[]>;
        setState: (id: string, state: string) => Promise<SessionRow[]>;
        setDraft: (id: string, draft: string | null) => Promise<void>;
        cancelPending: (id: string) => Promise<SessionRow[]>;
        setApiKey: (id: string, apiKeyId: string | null) => Promise<SessionRow[]>;
      };
      projects: {
        list: () => Promise<ProjectRow[]>;
        listSessions: (projectId: string) => Promise<SessionRow[]>;
        rename: (id: string, name: string | null) => Promise<ProjectRow[]>;
        setVisuals: (
          id: string,
          color: string | null,
          emoji: string | null
        ) => Promise<ProjectRow[]>;
        archive: (id: string, archived: boolean) => Promise<ProjectRow[]>;
      };
      settings: {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string) => Promise<void>;
        list: () => Promise<{ key: string; value: string }[]>;
      };
      audit: {
        list: (opts?: {
          sessionId?: string;
          limit?: number;
          beforeId?: number | null;
        }) => Promise<AuditEventRow[]>;
      };
      budget: {
        status: (apiKeyId?: string | null) => Promise<BudgetStatus>;
        forceResume: (sessionId: string) => Promise<{ ok: boolean }>;
      };
      apiKeys: {
        list: () => Promise<ApiKey[]>;
        create: (args: {
          name: string;
          plain: string;
          dailyBudgetUsd?: number | null;
          perTurnCapUsd?: number | null;
          setDefault?: boolean;
          activeHourStart?: number;
          activeHourEnd?: number;
        }) => Promise<{ ok: boolean; id: string | null; keys: ApiKey[] }>;
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
        ) => Promise<{ ok: boolean; keys: ApiKey[] }>;
        setDefault: (id: string) => Promise<ApiKey[]>;
        delete: (
          id: string
        ) => Promise<{ keys: ApiKey[]; sessions: SessionRow[] }>;
        /**
         * Zero out accumulated hourly carry-over (under/over-spend) for
         * one key and re-anchor the adjustment clock to the current
         * hour. Historical `usage_events` rows are untouched. Surfaced
         * as a per-key "Reset overages/underages" button on the
         * Settings page.
         */
        resetBudgetAdjustment: (
          id: string
        ) => Promise<{ ok: boolean; keys: ApiKey[] }>;
      };
      mcp: {
        list: () => Promise<McpServerStatus[]>;
        signIn: (name: string) => Promise<{ ok: boolean; error?: string }>;
        signOut: (name: string) => Promise<{ ok: boolean; error?: string }>;
      };
      skills: {
        list: (cwd: string | null) => Promise<{ skills: SkillSummary[] }>;
      };
      imports: {
        run: () => Promise<ImportProgress>;
        onProgress: (cb: (p: ImportProgress) => void) => () => void;
      };
      secret: {
        hasKey: () => Promise<boolean>;
        setKey: (key: string) => Promise<boolean>;
      };
      dialog: {
        pickDirectory: (defaultPath?: string) => Promise<string | null>;
      };
      chrome: {
        status: () => Promise<{
          status: 'disconnected' | 'connecting' | 'connected' | 'error';
          port: number | null;
          error: string | null;
          connectedAt: number | null;
          tabCount: number;
        }>;
        connect: (port?: number) => Promise<{
          ok: boolean;
          error?: string;
          status: {
            status: 'disconnected' | 'connecting' | 'connected' | 'error';
            port: number | null;
            error: string | null;
            connectedAt: number | null;
            tabCount: number;
          };
        }>;
        disconnect: () => Promise<{
          ok: boolean;
          status: {
            status: 'disconnected' | 'connecting' | 'connected' | 'error';
            port: number | null;
            error: string | null;
            connectedAt: number | null;
            tabCount: number;
          };
        }>;
      };
      agent: {
        loadMessages: (
          sessionId: string,
          opts?: { fallbackPath?: string }
        ) => Promise<
          {
            role: 'user' | 'assistant';
            content: string | unknown[];
            ts: number | null;
          }[]
        >;
        run: (args: {
          sessionId: string;
          projectId: string;
          cwd: string;
          userText: string;
          attachments?: Attachment[];
          seedFromJsonl?: string | null;
        }) => Promise<{ started: boolean; alreadyRunning: boolean }>;
        cancel: (sessionId: string) => Promise<{ ok: boolean }>;
        interrupt: (
          sessionId: string,
          text: string
        ) => Promise<{ ok: boolean; pending: number }>;
        removeInterrupt: (
          sessionId: string,
          text: string
        ) => Promise<{ ok: boolean; removed: boolean }>;
        isRunning: (sessionId: string) => Promise<boolean>;
        onEvent: (cb: (e: AgentEvent) => void) => () => void;
      };
      update: {
        status: () => Promise<UpdateState>;
        check: () => Promise<UpdateState | { error: string }>;
        install: (opts?: { force?: boolean }) => Promise<{
          ok: boolean;
          error?: string;
          state?: UpdateState;
          drainedAfterMs?: number;
        }>;
        onEvent: (cb: (state: UpdateState) => void) => () => void;
      };
    };
  }
}

/**
 * Auto-updater state machine snapshot. Exposed as a top-level type
 * because both `electron/autoUpdater.ts` (the source of truth) and
 * the renderer's `UpdateBanner` component use it. Keep this in
 * lockstep with `UpdateState` in `electron/autoUpdater.ts`.
 */
export interface UpdateState {
  state:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'error'
    | 'disabled';
  availableVersion: string | null;
  currentVersion: string;
  error: string | null;
  downloadPercent: number;
  lastCheckedAt: number | null;
}

export {};
