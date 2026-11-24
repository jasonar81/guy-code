/**
 * The daemon's database: `${CLAUDE_PLUGIN_DATA}/a2a.db` (design 7.2).
 *
 * Tables:
 *   - the A2A tables from design 6.2, applied with Guy Code's own schema.ts
 *     (A2A_SCHEMA_SQL + the P2 and P3 column migrations), so the daemon's
 *     store is exactly Guy Code's store. The session-specific column
 *     (`sessions.wait_a2a`) is skipped because there is no `sessions` table:
 *     Claude Code sessions do not sleep in a tool, they end their turn and
 *     the answer arrives as a channel event or hook context (design 7.3);
 *   - `cc_sessions`: Claude Code sessions registered by the SessionStart hook
 *     (design 7.2), the routing targets;
 *   - `inbox`: every item handed to a session, with `delivered_ts` (written to
 *     the MCP channel stream) and `acked_ts` (Claude has certainly seen it).
 *     Channel notifications are NOT acknowledged by Claude Code and are
 *     dropped silently when channels are off, so "delivered" proves nothing;
 *     only "acked" stops the UserPromptSubmit hook from re-surfacing it;
 *   - `cc_settings`: small key/value settings (TLS certificate, labels);
 *   - the rooms tables (design 11b, Guy Code migration v18, schema.ts
 *     A2A_ROOMS_SQL): `a2a_session_identities` (one cert per Claude Code
 *     SESSION; its private key is in secrets.json as a2a.session.<id>.key),
 *     `a2a_rooms`, `a2a_room_members`, `a2a_room_messages`,
 *     `a2a_room_invites`. All CREATE TABLE IF NOT EXISTS, so an existing
 *     a2a.db gains them on the next daemon start and re-running is harmless.
 *
 * sql.js (pure WASM, already a Guy Code dependency) rather than a native
 * sqlite module, so the plugin needs no compiler on install and runs on any
 * Node >= 20. sql.js is in-memory, so writes mark the database dirty and it
 * is saved to disk shortly after, through a temp file and a rename so a crash
 * mid-write cannot truncate it (the same trap db.ts documents for Guy Code).
 */
import initSqlJs, { type Database } from 'sql.js';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { A2A_SCHEMA_SQL, applyA2AP2Schema, applyA2AP3Schema, applyA2ARelaySchema, applyA2ARoomsSchema, type SqlHandle } from './shared/protocol';

export const CC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cc_sessions (
    session_id TEXT PRIMARY KEY,
    cwd TEXT,
    project TEXT,
    label TEXT,
    mcp_conn_id TEXT,
    last_seen_ts INTEGER,
    channel_ok INTEGER,
    cc_pid INTEGER,
    transcript_path TEXT,
    last_prompt TEXT,
    ended_ts INTEGER,
    created_ts INTEGER
  );
  CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY,
    peer TEXT,
    task_id TEXT,
    context_id TEXT,
    routed_session TEXT,
    kind TEXT,
    envelope TEXT NOT NULL,
    meta_json TEXT,
    created_ts INTEGER,
    delivered_ts INTEGER,
    acked_ts INTEGER,
    acked_via TEXT
  );
  CREATE INDEX IF NOT EXISTS inbox_session ON inbox(routed_session, acked_ts);
  CREATE TABLE IF NOT EXISTS cc_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

/** Apply every table the daemon needs. Idempotent. */
export function applyDaemonSchema(raw: Database): void {
  raw.exec(A2A_SCHEMA_SQL);
  const columnsOf = (table: string) => {
    const r = raw.exec(`PRAGMA table_info(${table})`);
    return r.length ? r[0].values.map((v) => String(v[r[0].columns.indexOf('name')])) : [];
  };
  applyA2AP2Schema((q) => raw.exec(q), columnsOf);
  applyA2AP3Schema((q) => raw.exec(q), columnsOf);
  applyA2ARelaySchema((q) => raw.exec(q), columnsOf);
  // Rooms (Guy Code migration v18): without these tables A2ANode's
  // RoomManager finds nothing to list and rooms silently switch themselves off.
  applyA2ARoomsSchema((q) => raw.exec(q));
  raw.exec(CC_SCHEMA_SQL);
}

/** The prepare().run/all/get handle store.ts expects, over a sql.js database. */
export function sqlHandle(raw: Database, onWrite: () => void = () => {}): SqlHandle {
  const h: SqlHandle = {
    prepare: (q: string) => ({
      run: (...p: unknown[]) => {
        raw.run(q, p as any);
        onWrite();
      },
      all: <T,>(...p: unknown[]) => {
        const st = raw.prepare(q);
        try {
          if (p.length) st.bind(p as any);
          const rows: T[] = [];
          while (st.step()) rows.push(st.getAsObject() as T);
          return rows;
        } finally {
          st.free();
        }
      },
      get: <T,>(...p: unknown[]) => h.prepare(q).all<T>(...p)[0],
    }),
  };
  return h;
}

type SqlJs = Awaited<ReturnType<typeof initSqlJs>>;
let _sql: SqlJs | null = null;

async function sqlJs(): Promise<SqlJs> {
  if (_sql) return _sql;
  // In the bundled plugin, build.mjs copies sql-wasm.wasm next to the
  // scripts in dist/. In development (tests) sql.js finds its own file.
  const local = typeof __dirname === 'string' ? join(__dirname, 'sql-wasm.wasm') : '';
  _sql = await initSqlJs(local && existsSync(local) ? { locateFile: () => local } : undefined);
  return _sql;
}

/** A throwaway database with the full schema (tests). */
export async function openMemoryDb(): Promise<{ raw: Database; sql: SqlHandle }> {
  const SQL = await sqlJs();
  const raw = new SQL.Database();
  applyDaemonSchema(raw);
  return { raw, sql: sqlHandle(raw) };
}

/**
 * The daemon's on-disk database. Writes are saved 250 ms after the last one
 * (and on `flush()`, which the daemon calls on shutdown).
 */
export async function openFileDb(path: string): Promise<{ raw: Database; sql: SqlHandle; flush(): void }> {
  const SQL = await sqlJs();
  const raw = existsSync(path) ? new SQL.Database(readFileSync(path)) : new SQL.Database();
  applyDaemonSchema(raw);
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, Buffer.from(raw.export()), { mode: 0o600 });
    renameSync(tmp, path);
  };
  const onWrite = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        flush();
      } catch {
        /* the next write retries */
      }
    }, 250);
    timer.unref?.();
  };
  flush();
  return { raw, sql: sqlHandle(raw, onWrite), flush };
}
