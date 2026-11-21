/**
 * `cc_sessions` and `inbox` (design 7.2), and the at-least-once rules.
 *
 * Why an inbox at all: a Claude Code session is not a long-lived process we
 * can call into the way Guy Code's router calls runUserTurn. Inbound text can
 * only reach Claude two ways:
 *   1. the MCP channel (`notifications/claude/channel`), which Claude Code
 *      does NOT acknowledge and drops without a trace when channels are off,
 *      the org blocks them, or the session was not started with --channels;
 *   2. the UserPromptSubmit / SessionStart hooks, which return
 *      `additionalContext` that Claude certainly sees.
 * So every item is stored, `delivered_ts` records "written to the channel"
 * (no proof of anything), and `acked_ts` records "Claude has certainly seen
 * it": set by the hook when it injects the item, or by an a2a_* tool call
 * that references the item. The hook re-surfaces anything delivered but not
 * acked, which is what makes delivery at-least-once with channels off.
 *
 * Routing (design 5.4 / 7.2): context mapping, then toSession (label, else
 * the cwd's last segment), then toProject (cwd last segment or project),
 * then the most recently active registered session, else held with
 * routed_session NULL until a session starts. Paths are split on BOTH
 * separators by hand: a Windows peer's "C:\w\xgsrc" must match a POSIX
 * daemon's "/home/d/xgsrc" and vice versa. node:path's basename got this
 * wrong on Linux and macOS in v1.10.0.
 */
import { lastPathSegment, type RoutableSession, type SqlHandle } from './shared/protocol';

export interface CcSessionRow {
  session_id: string;
  cwd: string | null;
  project: string | null;
  label: string | null;
  mcp_conn_id: string | null;
  last_seen_ts: number | null;
  channel_ok: number | null;
  cc_pid: number | null;
  transcript_path: string | null;
  last_prompt: string | null;
  ended_ts: number | null;
  created_ts: number | null;
}

export interface InboxRow {
  id: number;
  peer: string | null;
  task_id: string | null;
  context_id: string | null;
  routed_session: string | null;
  kind: string | null;
  envelope: string;
  meta_json: string | null;
  created_ts: number | null;
  delivered_ts: number | null;
  acked_ts: number | null;
  acked_via: string | null;
}

/** Sessions not seen for this long stop being routing targets (they still get held items when they come back). */
export const SESSION_STALE_MS = 7 * 24 * 3_600_000;

export class CcStore {
  constructor(
    private readonly db: SqlHandle,
    private readonly now: () => number = Date.now
  ) {}

  // ---- sessions ------------------------------------------------------------

  /** SessionStart (or a later hook) registering / refreshing a session. */
  registerSession(a: { sessionId: string; cwd?: string | null; transcriptPath?: string | null; ccPid?: number | null }): CcSessionRow {
    const now = this.now();
    const cwd = a.cwd ? String(a.cwd) : null;
    const project = cwd ? lastPathSegment(cwd) || null : null;
    this.db
      .prepare(
        `INSERT INTO cc_sessions (session_id, cwd, project, last_seen_ts, cc_pid, transcript_path, created_ts, ended_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           cwd = COALESCE(excluded.cwd, cc_sessions.cwd),
           project = COALESCE(excluded.project, cc_sessions.project),
           last_seen_ts = excluded.last_seen_ts,
           cc_pid = COALESCE(excluded.cc_pid, cc_sessions.cc_pid),
           transcript_path = COALESCE(excluded.transcript_path, cc_sessions.transcript_path),
           ended_ts = NULL`
      )
      .run(a.sessionId, cwd, project, now, a.ccPid ?? null, a.transcriptPath ?? null, now);
    return this.getSession(a.sessionId)!;
  }

  getSession(id: string): CcSessionRow | undefined {
    return this.db.prepare('SELECT * FROM cc_sessions WHERE session_id = ?').get<CcSessionRow>(id);
  }

  listSessions(includeEnded = false): CcSessionRow[] {
    return this.db
      .prepare(`SELECT * FROM cc_sessions ${includeEnded ? '' : 'WHERE ended_ts IS NULL'} ORDER BY last_seen_ts DESC`)
      .all<CcSessionRow>();
  }

  touchSession(id: string, patch: { lastPrompt?: string; channelOk?: boolean | null; mcpConnId?: string | null } = {}): void {
    const cur = this.getSession(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE cc_sessions SET last_seen_ts = ?, last_prompt = ?, channel_ok = ?, mcp_conn_id = ? WHERE session_id = ?')
      .run(
        this.now(),
        patch.lastPrompt !== undefined ? patch.lastPrompt.slice(0, 4000) : cur.last_prompt,
        patch.channelOk === undefined ? cur.channel_ok : patch.channelOk === null ? null : patch.channelOk ? 1 : 0,
        patch.mcpConnId !== undefined ? patch.mcpConnId : cur.mcp_conn_id,
        id
      );
  }

  setLabel(id: string, label: string | null): void {
    this.db.prepare('UPDATE cc_sessions SET label = ? WHERE session_id = ?').run(label ? label.trim().slice(0, 80) : null, id);
  }

  endSession(id: string): void {
    this.db.prepare('UPDATE cc_sessions SET ended_ts = ?, mcp_conn_id = NULL WHERE session_id = ?').run(this.now(), id);
  }

  /**
   * The registered session an MCP server process belongs to (design Q2: no
   * env var carries the session id into the MCP subprocess). Prefer the one
   * whose Claude Code pid matches the MCP process's parent, then the most
   * recent live session in the same cwd.
   */
  correlate(a: { ccPid?: number | null; cwd?: string | null }): CcSessionRow | undefined {
    const live = this.listSessions();
    if (a.ccPid) {
      const byPid = live.find((s) => s.cc_pid === a.ccPid);
      if (byPid) return byPid;
    }
    if (a.cwd) {
      const want = normCwd(a.cwd);
      return live.find((s) => s.cwd && normCwd(s.cwd) === want);
    }
    return undefined;
  }

  /** The same rows in the shape Guy Code's router expects (RoutableSession). */
  routable(): RoutableSession[] {
    const now = this.now();
    return this.listSessions()
      .filter((s) => now - (s.last_seen_ts ?? 0) < SESSION_STALE_MS)
      .map((s) => ({
        id: s.session_id,
        project_id: (s.project ?? '').toLowerCase(),
        cwd: s.cwd,
        jsonl_path: s.transcript_path ?? '',
        jsonl_mtime: s.last_seen_ts ?? 0,
        state: 'idle',
        archived: 0,
        title: s.label ?? s.project ?? null,
        user_title: s.label,
      }));
  }

  // ---- inbox -----------------------------------------------------------------

  addItem(a: { peer: string | null; taskId: string | null; contextId: string | null; sessionId: string | null; kind: string; envelope: string; meta: Record<string, string> }): InboxRow {
    if (!a.envelope) throw new Error('inbox items must carry an envelope');
    this.db
      .prepare('INSERT INTO inbox (peer, task_id, context_id, routed_session, kind, envelope, meta_json, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.peer, a.taskId, a.contextId, a.sessionId, a.kind, a.envelope, JSON.stringify(a.meta), this.now());
    return this.db.prepare('SELECT * FROM inbox ORDER BY id DESC LIMIT 1').get<InboxRow>()!;
  }

  getItem(id: number): InboxRow | undefined {
    return this.db.prepare('SELECT * FROM inbox WHERE id = ?').get<InboxRow>(id);
  }

  /** Not yet acked, for this session (and items held for nobody, which the first session to ask claims). */
  unacked(sessionId: string): InboxRow[] {
    return this.db
      .prepare('SELECT * FROM inbox WHERE acked_ts IS NULL AND (routed_session = ? OR routed_session IS NULL) ORDER BY id')
      .all<InboxRow>(sessionId);
  }

  allUnacked(): InboxRow[] {
    return this.db.prepare('SELECT * FROM inbox WHERE acked_ts IS NULL ORDER BY id').all<InboxRow>();
  }

  recent(limit = 50): InboxRow[] {
    return this.db.prepare('SELECT * FROM inbox ORDER BY id DESC LIMIT ?').all<InboxRow>(limit);
  }

  /** Give held (unrouted) items to a session that has just appeared. */
  claimHeld(sessionId: string): number {
    const held = this.db.prepare('SELECT id FROM inbox WHERE routed_session IS NULL AND acked_ts IS NULL').all<{ id: number }>();
    if (held.length) this.db.prepare('UPDATE inbox SET routed_session = ? WHERE routed_session IS NULL AND acked_ts IS NULL').run(sessionId);
    return held.length;
  }

  markDelivered(id: number): void {
    this.db.prepare('UPDATE inbox SET delivered_ts = COALESCE(delivered_ts, ?) WHERE id = ?').run(this.now(), id);
  }

  ack(ids: number[], via: string): number {
    let n = 0;
    for (const id of ids) {
      const cur = this.getItem(id);
      if (!cur || cur.acked_ts) continue;
      this.db.prepare('UPDATE inbox SET acked_ts = ?, acked_via = ? WHERE id = ?').run(this.now(), via, id);
      n++;
    }
    return n;
  }

  ackByContext(contextId: string, sessionId: string | null, via: string): number {
    const ids = this.db
      .prepare('SELECT id FROM inbox WHERE context_id = ? AND acked_ts IS NULL AND (routed_session = ? OR routed_session IS NULL)')
      .all<{ id: number }>(contextId, sessionId)
      .map((r) => r.id);
    return this.ack(ids, via);
  }

  /** An a2a_* tool referencing a task counts as seeing every item about it (design 7.3). */
  ackByTask(taskId: string, via: string): number {
    const ids = this.db.prepare('SELECT id FROM inbox WHERE task_id = ? AND acked_ts IS NULL').all<{ id: number }>(taskId).map((r) => r.id);
    return this.ack(ids, via);
  }
}

/** Compare cwds across separators and Windows case-insensitivity. */
export function normCwd(p: string): string {
  const s = String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}
