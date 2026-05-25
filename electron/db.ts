// SQLite via sql.js (pure WASM — no native compilation needed).
//
// Persistence model:
//   - DB is loaded into memory from `guycode.db` on init
//   - Mutations flag `dirty = true`
//   - Periodic flush every 5s; final flush on app quit
//   - Flushes are ATOMIC: write to `guycode.db.tmp`, then rename onto
//     `guycode.db`. A direct `writeFileSync` on the real file truncates
//     it to zero before the bytes land — and if the process is killed
//     in that window (crash, hot-reload SIGTERM, force-quit) the user
//     comes back to a 0-byte DB and loses *everything* in the file
//     including settings + live usage events. The temp+rename pattern
//     means the original is intact until the rename completes.
//   - Startup makes a rolling backup (`guycode.db.bak.N`, last 5 kept)
//     so that even if the atomic write somehow doesn't save us, the
//     user has a recent good copy to fall back on.
//   - All cost data lives in this single file under %USERPROFILE%\.guycode\
//
// Adapter: thin wrapper around sql.js that mimics better-sqlite3's
// `prepare().run/.all/.get` API so call sites stay readable.

import initSqlJs, { Database, SqlJsStatic, BindParams } from 'sql.js';
import { app } from 'electron';
import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import log from 'electron-log';

let SQL: SqlJsStatic | null = null;
let _db: Database | null = null;
let _dbPath = '';
let _dirty = false;
let _flushTimer: NodeJS.Timeout | null = null;

export function getDataDir(): string {
  const home = app.getPath('home');
  const dir = join(home, '.guycode');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadWasmBytes(): Uint8Array {
  // sql.js ships with sql-wasm.wasm in dist/. Find it relative to where the
  // app is installed. We try several candidates so the same code works in
  // dev (vite-plugin-electron CJS output) and after packaging.
  const tryPaths: string[] = [];

  // 1. App root node_modules (dev + most packaged layouts)
  try {
    tryPaths.push(
      join(app.getAppPath(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    );
  } catch {
    /* app may not be ready */
  }

  // 2. Walk up from __dirname looking for node_modules/sql.js
  let cur = __dirname;
  for (let i = 0; i < 6; i++) {
    tryPaths.push(join(cur, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
    cur = join(cur, '..');
  }

  // 3. Co-located with the bundled main (post-package fallback)
  tryPaths.push(join(__dirname, 'sql-wasm.wasm'));

  // 4. Electron resourcesPath (used by electron-builder asarUnpack)
  if (process.resourcesPath) {
    tryPaths.push(join(process.resourcesPath, 'sql-wasm.wasm'));
    tryPaths.push(
      join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
    );
  }

  for (const p of tryPaths) {
    try {
      if (existsSync(p)) {
        log.info(`[db] loading sql-wasm.wasm from ${p}`);
        return new Uint8Array(readFileSync(p));
      }
    } catch {
      /* keep trying */
    }
  }
  throw new Error(`Could not locate sql-wasm.wasm. Tried:\n${tryPaths.join('\n')}`);
}

export async function initDb(): Promise<void> {
  if (_db) return;
  // sql.js's `wasmBinary` option is typed as `ArrayBuffer`, but accepts any
  // BufferSource at runtime. Pass the underlying `.buffer` (an ArrayBuffer)
  // so the type-check passes without forcing a copy.
  const wasm = loadWasmBytes();
  // The slice() result is typed as ArrayBuffer | SharedArrayBuffer because
  // wasm.buffer could in principle be either. Node always gives a regular
  // ArrayBuffer here; cast to satisfy initSqlJs's narrower signature.
  const wasmAB = wasm.buffer.slice(
    wasm.byteOffset,
    wasm.byteOffset + wasm.byteLength
  ) as ArrayBuffer;
  SQL = await initSqlJs({ wasmBinary: wasmAB });

  const dir = getDataDir();
  _dbPath = join(dir, 'guycode.db');

  // Orphan recovery: if `guycode.db.tmp` is sitting around from a
  // previous flush that didn't get to rename, log it and remove it.
  // We don't try to use the temp as a recovery source because it
  // could be partially-written; the safer move is to fall back to
  // the backups dir if the user needs an older copy.
  const tmpPath = _dbPath + '.tmp';
  if (existsSync(tmpPath)) {
    try {
      const tStat = statSync(tmpPath);
      log.warn(
        `[db] orphan ${tmpPath} present (${tStat.size} bytes) — removing. ` +
          `Likely from an interrupted flush; the real DB should be intact.`
      );
      unlinkSync(tmpPath);
    } catch (e) {
      log.warn('[db] could not remove orphan tmp file', e);
    }
  }

  if (existsSync(_dbPath)) {
    let buf: Buffer;
    try {
      buf = readFileSync(_dbPath);
    } catch (e) {
      log.error(`[db] failed to load ${_dbPath}, starting fresh:`, e);
      _db = new SQL.Database();
      log.info(`[db] new DB at ${_dbPath}`);
      // Skip the rest of the load branch.
      buf = Buffer.alloc(0);
    }
    if (!_db) {
      // Zero-byte recovery: a prior flush got SIGTERM'd between
      // truncate and write, leaving the DB at zero bytes. Without
      // this branch, we'd silently init a fresh empty DB and the
      // claudeImport sweep would re-populate ONLY imported sessions
      // — losing all live data, archived flags, settings, and the
      // encrypted API key. Restoring from the latest startup backup
      // gets us back to last-known-good. The user re-enters at most
      // one session's worth of activity (since the most recent
      // backup) instead of *everything*.
      if (buf.length === 0) {
        log.error(
          `[db] CORRUPTION: ${_dbPath} is zero bytes. Attempting to ` +
            `restore from latest startup backup before falling back to fresh DB.`
        );
        const restored = tryRestoreFromBackup();
        if (restored) {
          buf = readFileSync(_dbPath);
          log.info(
            `[db] restored from backup; loaded DB is now ${buf.length} bytes`
          );
        }
      }
      if (buf.length > 0) {
        try {
          _db = new SQL.Database(new Uint8Array(buf));
          log.info(
            `[db] loaded existing DB at ${_dbPath} (${buf.length} bytes)`
          );
        } catch (e) {
          log.error(`[db] failed to parse ${_dbPath} bytes, starting fresh:`, e);
          _db = new SQL.Database();
        }
      } else {
        _db = new SQL.Database();
        log.warn(`[db] starting fresh — ${_dbPath} was empty and no backup available`);
      }
    }
  } else {
    _db = new SQL.Database();
    log.info(`[db] new DB at ${_dbPath}`);
  }

  // Rolling startup backup BEFORE migrations run, so that if a future
  // migration corrupts the DB the user has a clean pre-migration copy
  // to roll back to. Skipped for zero-byte DBs (a fresh-install state)
  // since there's nothing useful to preserve and we don't want a
  // zero-byte backup evicting a good one.
  rotateStartupBackup();

  _db.exec('PRAGMA foreign_keys = ON');
  migrate(_db);
  flush(); // ensure freshly migrated DB hits disk

  _flushTimer = setInterval(() => flush(), 5000);

  app.on('before-quit', () => {
    flush();
    if (_flushTimer) clearInterval(_flushTimer);
  });
}

function flush() {
  if (!_db || !_dirty) return;
  try {
    // Atomic write: serialize to a temp file in the same directory,
    // then rename onto the real path. `renameSync` is atomic on the
    // same volume on Windows (since NTFS), Linux, and macOS — the
    // OS swaps the directory entry in a single inode operation. So
    // either the rename completes (new bytes visible) or it doesn't
    // (old bytes still there). There is no in-between window where
    // the real file exists at zero bytes.
    //
    // The previous direct `writeFileSync(_dbPath, ...)` had a window
    // between the open(O_TRUNC) syscall and the write completing
    // where the file was zero bytes on disk. A SIGTERM during that
    // window — common during dev hot-reloads, where vite-plugin-
    // electron kills+respawns the main process — landed the user
    // with a zero-byte DB on next startup, which then triggered a
    // fresh-install init path that re-imported sessions but lost
    // every column the import doesn't seed (archive flags, state,
    // settings table including the encrypted API key, all live
    // usage events).
    const data = _db.export();
    const tmpPath = _dbPath + '.tmp';
    writeFileSync(tmpPath, Buffer.from(data));
    renameSync(tmpPath, _dbPath);
    _dirty = false;
  } catch (e) {
    log.error('[db] flush failed', e);
  }
}

/**
 * If the live DB is zero bytes / unparseable, copy the most recent
 * startup backup over `_dbPath`. Returns true if a backup was found
 * and copied. Caller is expected to re-`readFileSync` afterwards.
 *
 * Picks the lex-greatest filename in `~/.guycode/backups/`, which
 * works because they're prefixed with an ISO-ish timestamp.
 */
function tryRestoreFromBackup(): boolean {
  try {
    const dir = join(getDataDir(), 'backups');
    if (!existsSync(dir)) return false;
    const all = readdirSync(dir)
      .filter((n) => n.startsWith('guycode-') && n.endsWith('.db'))
      .sort();
    if (all.length === 0) return false;
    // Pick the newest non-empty backup (defensive — should always be non-empty
    // because rotateStartupBackup() refuses to snapshot 0-byte DBs).
    for (let i = all.length - 1; i >= 0; i--) {
      const candidate = join(dir, all[i]);
      try {
        const st = statSync(candidate);
        if (st.size > 0) {
          copyFileSync(candidate, _dbPath);
          log.info(`[db] restored ${_dbPath} from ${candidate} (${st.size} bytes)`);
          return true;
        }
      } catch {
        /* try the next-newest */
      }
    }
    log.error('[db] no usable (non-empty) backup found');
    return false;
  } catch (e) {
    log.error('[db] tryRestoreFromBackup failed', e);
    return false;
  }
}

/**
 * Rolling backup taken at startup, before any migrations run.
 * Keeps the last `MAX_BACKUPS` snapshots in `~/.guycode/backups/`.
 * Cheap insurance against catastrophic disk/migration failures —
 * a 70 MB DB copies in well under a second on local SSDs.
 *
 * Names: `guycode-YYYYMMDD-HHMMSS.db`. Sorting alphabetically gives
 * chronological order, which we exploit when pruning the oldest.
 */
const MAX_BACKUPS = 5;
function rotateStartupBackup(): void {
  if (!_dbPath || !existsSync(_dbPath)) return;
  try {
    const stat = statSync(_dbPath);
    if (stat.size === 0) {
      // Don't snapshot a zero-byte DB — would just waste a backup
      // slot and potentially evict a good one.
      log.warn('[db] skipping startup backup: DB file is 0 bytes');
      return;
    }
    const dir = join(getDataDir(), 'backups');
    mkdirSync(dir, { recursive: true });
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 15);
    const target = join(dir, `guycode-${ts}.db`);
    copyFileSync(_dbPath, target);
    log.info(`[db] startup backup written: ${target} (${stat.size} bytes)`);

    // Prune oldest beyond MAX_BACKUPS. We list and lex-sort, which
    // works because of the timestamp-prefixed names.
    const all = readdirSync(dir)
      .filter((n) => n.startsWith('guycode-') && n.endsWith('.db'))
      .sort();
    while (all.length > MAX_BACKUPS) {
      const oldest = all.shift()!;
      try {
        unlinkSync(join(dir, oldest));
      } catch (e) {
        log.warn(`[db] could not prune old backup ${oldest}`, e);
      }
    }
  } catch (e) {
    log.warn('[db] startup backup failed (non-fatal)', e);
  }
}

export function markDirty() {
  _dirty = true;
}

/**
 * Force an immediate write to disk. Use sparingly for events that MUST
 * survive an unexpected crash (e.g. usage cost accounting) — the normal
 * 5-second flush interval would lose up to 5 seconds of spend tracking.
 */
export function flushNow() {
  flush();
}

function rawDb(): Database {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

// ---- Tiny better-sqlite3-like adapter ----

class PreparedStmt {
  constructor(private sql: string) {}

  private flat(params: unknown[]): BindParams {
    const fp =
      params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
    return fp as BindParams;
  }

  run(...params: unknown[]): void {
    rawDb().run(this.sql, this.flat(params));
    _dirty = true;
  }

  all<T = Record<string, unknown>>(...params: unknown[]): T[] {
    const stmt = rawDb().prepare(this.sql);
    try {
      const bp = this.flat(params);
      if (Array.isArray(bp) && bp.length > 0) stmt.bind(bp);
      else if (!Array.isArray(bp) && bp && Object.keys(bp).length > 0) stmt.bind(bp);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as T);
      return rows;
    } finally {
      stmt.free();
    }
  }

  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined {
    const r = this.all<T>(...params);
    return r[0];
  }
}

interface DbWrapper {
  prepare: (sql: string) => PreparedStmt;
  exec: (sql: string) => void;
  transaction: <T extends (...args: unknown[]) => unknown>(fn: T) => T;
}

let _wrapper: DbWrapper | null = null;

export function db(): DbWrapper {
  if (_wrapper) return _wrapper;
  _wrapper = {
    prepare: (sql: string) => new PreparedStmt(sql),
    exec: (sql: string) => {
      rawDb().exec(sql);
      _dirty = true;
    },
    transaction: <T extends (...args: unknown[]) => unknown>(fn: T): T => {
      const wrapped = ((...args: unknown[]) => {
        rawDb().exec('BEGIN');
        try {
          const r = fn(...args);
          rawDb().exec('COMMIT');
          _dirty = true;
          return r;
        } catch (e) {
          try {
            rawDb().exec('ROLLBACK');
          } catch {
            /* nested */
          }
          throw e;
        }
      }) as T;
      return wrapped;
    },
  };
  return _wrapper;
}

// ---- Schema migrations ----

function migrate(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `);
  const versionStmt = d.prepare('SELECT MAX(version) AS v FROM schema_version');
  versionStmt.step();
  const row = versionStmt.getAsObject() as { v: number | null };
  versionStmt.free();
  const current = row?.v ?? 0;

  const migrations: Array<{ version: number; up: string }> = [
    {
      version: 1,
      up: `
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          user_name TEXT,
          color TEXT,
          emoji TEXT,
          state TEXT NOT NULL DEFAULT 'idle',
          archived INTEGER NOT NULL DEFAULT 0,
          last_activity_ts INTEGER,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          jsonl_path TEXT NOT NULL,
          jsonl_mtime INTEGER NOT NULL,
          jsonl_size INTEGER NOT NULL,
          started_at INTEGER,
          ended_at INTEGER,
          message_count INTEGER NOT NULL DEFAULT 0,
          last_message_preview TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );
        CREATE INDEX sessions_project ON sessions(project_id);
        CREATE INDEX sessions_started ON sessions(started_at);

        CREATE TABLE usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          turn_id TEXT,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd_micros INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL
        );
        CREATE INDEX usage_project_ts ON usage_events(project_id, ts);
        CREATE INDEX usage_session ON usage_events(session_id);
        CREATE UNIQUE INDEX usage_dedup ON usage_events(session_id, turn_id) WHERE turn_id IS NOT NULL;

        CREATE TABLE imported_files (
          path TEXT PRIMARY KEY,
          size INTEGER NOT NULL,
          mtime INTEGER NOT NULL,
          last_byte_offset INTEGER NOT NULL DEFAULT 0,
          imported_at INTEGER NOT NULL
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          project_id TEXT NOT NULL,
          session_id TEXT,
          tool TEXT NOT NULL,
          input_json TEXT,
          output_ref TEXT,
          status TEXT NOT NULL,
          duration_ms INTEGER
        );
        CREATE INDEX audit_project_ts ON audit_events(project_id, ts);
      `,
    },
    {
      version: 2,
      up: `
        ALTER TABLE sessions ADD COLUMN title TEXT;
        ALTER TABLE sessions ADD COLUMN user_title TEXT;
        ALTER TABLE sessions ADD COLUMN color TEXT;
        ALTER TABLE sessions ADD COLUMN emoji TEXT;
        ALTER TABLE sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'idle';
        ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      version: 3,
      // Budget governor v2 needs to remember what the user was about to send
      // when a session paused, so we can auto-resume at the top of the next
      // hour without losing intent. Also tracks the moment we entered sleep
      // so the UI can show "Sleeps until 2:00 PM".
      up: `
        ALTER TABLE sessions ADD COLUMN pending_user_text TEXT;
        ALTER TABLE sessions ADD COLUMN sleeping_since INTEGER;
      `,
    },
    {
      version: 4,
      // Multi-API-key support. Each API key is its own row with its own
      // budget configuration (daily cap, per-turn cap). One key is marked
      // is_default = 1 (enforced in app code); new sessions inherit it.
      // sessions.api_key_id records which key a session uses; if NULL,
      // the runtime falls back to the current default. usage_events
      // carries api_key_id so budget queries can filter per-key without
      // a session join.
      //
      // The legacy single-key world (`apiKey.cipherB64` setting +
      // `budget.dailyBudgetUsd` / `budget.perTurnCapUsd` settings) is
      // migrated to a "Default" row inside the data-migration code in
      // `electron/secret.ts:migrateLegacyApiKey`. That migration runs
      // at app startup after `initDb()`, so it can use safeStorage to
      // round-trip the cipher without changing the encryption key.
      up: `
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          cipher_b64 TEXT NOT NULL,
          daily_budget_usd REAL,
          per_turn_cap_usd REAL,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX api_keys_default ON api_keys(is_default);

        ALTER TABLE sessions ADD COLUMN api_key_id TEXT;
        ALTER TABLE usage_events ADD COLUMN api_key_id TEXT;
        CREATE INDEX usage_events_api_key_ts ON usage_events(api_key_id, ts);
      `,
    },
    {
      version: 5,
      // Hourly carry-over budget state. The user's mental model is
      // dead simple: each clock hour gets `daily / 24`. If you underspend
      // an hour, the unused amount rolls into the next hour. If you
      // overspend, the next hour's effective cap is reduced by the
      // overage. Two columns on api_keys track this:
      //   • adjustment_micros — signed carry-over for the NEXT hour.
      //     A positive value means past hours underspent; negative means
      //     past hours overspent. Effective cap for any hour H is
      //     `(daily/24) + adjustment_as_of_start_of_H`.
      //   • adjustment_hour_ts — start-of-hour (ms) the adjustment is
      //     "as of". On any read we settle from this timestamp forward
      //     to the current hour using a single SUM over usage_events.
      // The columns default to 0/0 so a brand-new install (or a key
      // created after this migration) starts with a clean slate. The
      // Settings "Reset overages/underages" button rewinds back to this
      // initial state for one specific key.
      up: `
        ALTER TABLE api_keys ADD COLUMN adjustment_micros INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE api_keys ADD COLUMN adjustment_hour_ts INTEGER NOT NULL DEFAULT 0;
      `,
    },
    {
      version: 6,
      // Persistent dynamic plans. The model uses the Plan tool to
      // update/start/complete/abandon plans across a session. Each
      // session can have many plans over its lifetime, but at most
      // ONE in 'active' state at any time (enforced by the partial
      // unique index below).
      //
      // steps_json is a serialized array of {id, text, status, notes}
      // so the schema doesn't have to change every time we tweak the
      // step shape. The Plan UI panel and the system-prompt injector
      // both read it via the same JSON parse path.
      //
      // outcome_summary is set when the plan transitions to completed
      // or abandoned. For active plans it stays NULL.
      up: `
        CREATE TABLE plans (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'abandoned')),
          steps_json TEXT NOT NULL,
          outcome_summary TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_plans_session ON plans(session_id);
        CREATE UNIQUE INDEX idx_plans_one_active_per_session
          ON plans(session_id) WHERE state = 'active';
      `,
    },
  ];

  for (const m of migrations) {
    if (m.version > current) {
      log.info(`[db] applying migration v${m.version}`);
      d.exec('BEGIN');
      try {
        d.exec(m.up);
        d.run('INSERT INTO schema_version (version) VALUES (?)', [m.version]);
        d.exec('COMMIT');
      } catch (e) {
        d.exec('ROLLBACK');
        throw e;
      }
      _dirty = true;
    }
  }
}

// ---- Project queries ----

export interface ProjectRow {
  id: string;
  cwd: string;
  user_name: string | null;
  color: string | null;
  emoji: string | null;
  state: string;
  archived: number;
  last_activity_ts: number | null;
  created_at: number;
  cost_all_time_micros: number;
  cost_24h_micros: number;
  session_count: number;
  last_session_preview: string | null;
}

export function listProjects(): ProjectRow[] {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return db()
    .prepare(
      `
      SELECT
        p.id,
        p.cwd,
        p.user_name,
        p.color,
        p.emoji,
        p.state,
        p.archived,
        p.last_activity_ts,
        p.created_at,
        COALESCE((SELECT SUM(cost_usd_micros) FROM usage_events u WHERE u.project_id = p.id AND u.source = 'live'), 0) AS cost_all_time_micros,
        COALESCE((SELECT SUM(cost_usd_micros) FROM usage_events u WHERE u.project_id = p.id AND u.source = 'live' AND u.ts >= ?), 0) AS cost_24h_micros,
        COALESCE((SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id), 0) AS session_count,
        (SELECT last_message_preview
           FROM sessions s
          WHERE s.project_id = p.id
          ORDER BY COALESCE(s.ended_at, s.started_at, 0) DESC
          LIMIT 1) AS last_session_preview
      FROM projects p
      WHERE p.archived = 0
      ORDER BY COALESCE(p.last_activity_ts, p.created_at) DESC
    `
    )
    .all<ProjectRow>(dayAgo);
}

export function upsertProject(args: {
  id: string;
  cwd: string;
  lastActivityTs: number | null;
  createdAt: number;
}) {
  db()
    .prepare(
      `
      INSERT INTO projects (id, cwd, last_activity_ts, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_activity_ts = COALESCE(MAX(projects.last_activity_ts, excluded.last_activity_ts), excluded.last_activity_ts),
        cwd = excluded.cwd
    `
    )
    .run(args.id, args.cwd, args.lastActivityTs, args.createdAt);
}

export function setProjectName(id: string, name: string | null) {
  db().prepare('UPDATE projects SET user_name = ? WHERE id = ?').run(name, id);
}

export function setProjectVisuals(id: string, color: string | null, emoji: string | null) {
  db().prepare('UPDATE projects SET color = ?, emoji = ? WHERE id = ?').run(color, emoji, id);
}

export function setProjectArchived(id: string, archived: boolean) {
  db().prepare('UPDATE projects SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
}

export function setProjectState(id: string, state: string) {
  db()
    .prepare('UPDATE projects SET state = ?, last_activity_ts = ? WHERE id = ?')
    .run(state, Date.now(), id);
}

// ---- Session queries ----

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
  title: string | null;
  user_title: string | null;
  color: string | null;
  emoji: string | null;
  state: string;
  archived: number;
  pending_user_text: string | null;
  sleeping_since: number | null;
  /** API key this session uses; null = inherits the current default key. */
  api_key_id: string | null;
}

export interface SessionFullRow extends SessionRow {
  cwd: string | null;
  cost_all_time_micros: number;
  cost_24h_micros: number;
}

export function upsertSession(s: {
  id: string;
  projectId: string;
  jsonlPath: string;
  jsonlMtime: number;
  jsonlSize: number;
  startedAt: number | null;
  endedAt: number | null;
  messageCount: number;
  lastMessagePreview: string | null;
  title?: string | null;
}) {
  db()
    .prepare(
      `
      INSERT INTO sessions
        (id, project_id, jsonl_path, jsonl_mtime, jsonl_size, started_at, ended_at, message_count, last_message_preview, title)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        jsonl_path = excluded.jsonl_path,
        jsonl_mtime = excluded.jsonl_mtime,
        jsonl_size = excluded.jsonl_size,
        started_at = COALESCE(sessions.started_at, excluded.started_at),
        ended_at = excluded.ended_at,
        message_count = excluded.message_count,
        last_message_preview = excluded.last_message_preview,
        title = COALESCE(sessions.title, excluded.title)
    `
    )
    .run(
      s.id,
      s.projectId,
      s.jsonlPath,
      s.jsonlMtime,
      s.jsonlSize,
      s.startedAt,
      s.endedAt,
      s.messageCount,
      s.lastMessagePreview,
      s.title ?? null
    );
}

export function setSessionTitle(id: string, title: string | null) {
  db().prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}

export function setSessionUserTitle(id: string, userTitle: string | null) {
  db().prepare('UPDATE sessions SET user_title = ? WHERE id = ?').run(userTitle, id);
}

export function setSessionVisuals(id: string, color: string | null, emoji: string | null) {
  db().prepare('UPDATE sessions SET color = ?, emoji = ? WHERE id = ?').run(color, emoji, id);
}

export function setSessionArchived(id: string, archived: boolean) {
  db().prepare('UPDATE sessions SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
}

/**
 * Permanently remove a session row from the database. Used by the
 * sidebar's "Delete from disk" action together with an `unlink` of
 * the JSONL on the filesystem.
 *
 * Cascades to dependent tables so we don't leave dangling cost /
 * audit rows referencing a session that no longer exists. We
 * deliberately DELETE rather than mark soft-deleted because the user
 * asked for "permanently delete (including on disk)" — they want it
 * gone, not hidden.
 *
 * Re-import safety: if the user later re-runs the Claude import scan
 * and the source JSONL has been deleted, the session won't come back.
 * If the source JSONL still exists (e.g. they only deleted the Guy
 * copy), it WILL be re-imported. The caller is responsible for
 * deleting the source JSONL too if the user wants permanent removal.
 */
export function deleteSession(id: string): void {
  const d = db();
  // Best-effort cascade. We don't fail if a table doesn't exist (some
  // schema versions don't have all of them).
  for (const sql of [
    'DELETE FROM usage_events WHERE session_id = ?',
    'DELETE FROM audit_events WHERE session_id = ?',
    'DELETE FROM sessions WHERE id = ?',
  ]) {
    try {
      d.prepare(sql).run(id);
    } catch (e) {
      // Log but continue — partial cleanup is better than refusing.
      log.warn(`[db] deleteSession step failed: ${sql} → ${(e as Error).message}`);
    }
  }
}

export function setSessionState(id: string, state: string) {
  db()
    .prepare('UPDATE sessions SET state = ? WHERE id = ?')
    .run(state, id);
}

/**
 * On app startup, any session whose persisted `state` is `running` or
 * `waiting-on-system` is stale — the only way to get there is mid-turn
 * execution, and there's no agent process anymore to drive it forward.
 * (Common cause: the app was force-killed, crashed, or restarted while
 * a turn was in flight. Without this sweep the sidebar shows those
 * sessions under "Running" with state=idle in the status bar, leaving
 * the user with two contradictory truths.)
 *
 * Returns the number of rows updated so the caller can log it.
 *
 * Deliberately NOT reset:
 *   - `waiting-on-user`  — model genuinely asked a question; user can answer.
 *   - `sleeping-budget`  — budget governor owns this state; resume sweep handles it.
 *   - `error`            — preserve so the user sees what happened.
 *   - `idle`             — already correct.
 */
export function resetStaleRunningSessions(): number {
  // SELECT count first since sql.js's run() is void (unlike better-sqlite3
  // which returns a `changes` field). Two-query cost is negligible — this
  // runs once on startup.
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sessions
        WHERE state IN ('running', 'waiting-on-system')`
    )
    .get<{ n: number }>();
  const n = row?.n ?? 0;
  if (n > 0) {
    db()
      .prepare(
        `UPDATE sessions
           SET state = 'idle'
         WHERE state IN ('running', 'waiting-on-system')`
      )
      .run();
  }
  return n;
}

/**
 * Persist the user message that was about to be sent when the budget governor
 * paused the session. The resume sweep reads this back to auto-resume.
 * Setting `null` clears it (e.g. when a session resumes successfully).
 */
export function setSessionPending(
  id: string,
  pendingUserText: string | null,
  sleepingSince: number | null
) {
  db()
    .prepare(
      'UPDATE sessions SET pending_user_text = ?, sleeping_since = ? WHERE id = ?'
    )
    .run(pendingUserText, sleepingSince, id);
}

export function getSessionPending(
  id: string
): { pending_user_text: string | null; sleeping_since: number | null } | undefined {
  return db()
    .prepare(
      'SELECT pending_user_text, sleeping_since FROM sessions WHERE id = ?'
    )
    .get<{ pending_user_text: string | null; sleeping_since: number | null }>(id);
}

/** All sessions currently in a given state. Used by the budget resume sweep. */
export function listSessionsByState(state: string): {
  id: string;
  project_id: string;
  pending_user_text: string | null;
  sleeping_since: number | null;
  cwd: string | null;
  jsonl_path: string;
  api_key_id: string | null;
}[] {
  return db()
    .prepare(
      `SELECT s.id, s.project_id, s.pending_user_text, s.sleeping_since,
              p.cwd AS cwd, s.jsonl_path, s.api_key_id
         FROM sessions s
         LEFT JOIN projects p ON p.id = s.project_id
        WHERE s.state = ?`
    )
    .all<{
      id: string;
      project_id: string;
      pending_user_text: string | null;
      sleeping_since: number | null;
      cwd: string | null;
      jsonl_path: string;
      api_key_id: string | null;
    }>(state);
}

export function listSessionsForProject(projectId: string): SessionRow[] {
  return db()
    .prepare(
      `SELECT * FROM sessions WHERE project_id = ? ORDER BY COALESCE(ended_at, started_at, 0) DESC`
    )
    .all<SessionRow>(projectId);
}

/** Flat session list for the sidebar, with cost and cwd joined in. */
export function listSessionsAll(): SessionFullRow[] {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return db()
    .prepare(
      `
      SELECT
        s.id,
        s.project_id,
        s.jsonl_path,
        s.jsonl_mtime,
        s.jsonl_size,
        s.started_at,
        s.ended_at,
        s.message_count,
        s.last_message_preview,
        s.title,
        s.user_title,
        s.color,
        s.emoji,
        s.state,
        s.archived,
        s.pending_user_text,
        s.sleeping_since,
        s.api_key_id,
        p.cwd AS cwd,
        COALESCE(c.total, 0) AS cost_all_time_micros,
        COALESCE(c24.total, 0) AS cost_24h_micros
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN (
        SELECT session_id, SUM(cost_usd_micros) AS total FROM usage_events WHERE source = 'live' GROUP BY session_id
      ) c ON c.session_id = s.id
      LEFT JOIN (
        SELECT session_id, SUM(cost_usd_micros) AS total FROM usage_events WHERE source = 'live' AND ts >= ? GROUP BY session_id
      ) c24 ON c24.session_id = s.id
      ORDER BY COALESCE(s.ended_at, s.started_at, 0) DESC
    `
    )
    .all<SessionFullRow>(dayAgo);
}

/**
 * Set a session's API key. Pass null to clear (session falls back to the
 * default key at agent-run time). Used by the right-click sidebar menu.
 */
export function setSessionApiKey(id: string, apiKeyId: string | null): void {
  db()
    .prepare('UPDATE sessions SET api_key_id = ? WHERE id = ?')
    .run(apiKeyId, id);
}

/** Look up a session's persisted api_key_id (null if unset). */
export function getSessionApiKey(id: string): string | null {
  const r = db()
    .prepare('SELECT api_key_id FROM sessions WHERE id = ?')
    .get<{ api_key_id: string | null }>(id);
  return r?.api_key_id ?? null;
}

/**
 * List every session row that has a known JSONL file. Used by the title
 * backfill pass to upgrade titles when a `custom-title` / `ai-title` event
 * is found that beats the current title.
 */
export function listSessionsForTitleBackfill(): {
  id: string;
  jsonl_path: string;
  title: string | null;
}[] {
  return db()
    .prepare(
      `SELECT id, jsonl_path, title FROM sessions WHERE jsonl_path IS NOT NULL AND jsonl_path != ''`
    )
    .all<{ id: string; jsonl_path: string; title: string | null }>();
}

export function listSessionsMissingTitle(): { id: string; jsonl_path: string }[] {
  return db()
    .prepare(
      `SELECT id, jsonl_path FROM sessions WHERE (title IS NULL OR title = '') AND archived = 0`
    )
    .all<{ id: string; jsonl_path: string }>();
}

// ---- Usage events ----

export function insertUsageEvent(u: {
  ts: number;
  projectId: string;
  sessionId: string;
  turnId: string | null;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  costUsdMicros: number;
  source: 'imported' | 'live';
  /** API key responsible for the spend. Null for legacy imports. */
  apiKeyId?: string | null;
}) {
  try {
    db()
      .prepare(
        `
        INSERT INTO usage_events
          (ts, project_id, session_id, turn_id, model,
           input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, output_tokens,
           cost_usd_micros, source, api_key_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        u.ts,
        u.projectId,
        u.sessionId,
        u.turnId,
        u.model,
        u.inputTokens,
        u.cacheReadTokens,
        u.cacheWrite5mTokens,
        u.cacheWrite1hTokens,
        u.outputTokens,
        u.costUsdMicros,
        u.source,
        u.apiKeyId ?? null
      );
  } catch (e: unknown) {
    // Unique constraint on (session_id, turn_id) — already imported, ignore
    const msg = (e as { message?: string })?.message ?? '';
    if (msg.includes('UNIQUE') || msg.includes('constraint')) return;
    throw e;
  }
  // Live turns: bump the session's `ended_at` to this usage event's
  // timestamp so the sidebar's "Today / Yesterday / N days ago" group
  // tracks the most recent activity instead of the timestamp the import
  // pass first wrote. Without this, a session worked on today but
  // imported 2 days ago stays under "2 days ago" until the next full
  // import scan — which is the bug the user reported with the
  // BALD/MARVIN session. We only do this for live sources because
  // imported events already carry the right timestamps via upsertSession.
  if (u.source === 'live') {
    try {
      db()
        .prepare(
          `UPDATE sessions
             SET ended_at = ?,
                 started_at = COALESCE(started_at, ?)
           WHERE id = ?`
        )
        .run(u.ts, u.ts, u.sessionId);
      // Mirror the activity to the parent project so its
      // last_activity_ts is fresh too — keeps project ordering and
      // the "Today's spend" aggregates aligned.
      db()
        .prepare(
          `UPDATE projects SET last_activity_ts = ? WHERE id = ?`
        )
        .run(u.ts, u.projectId);
    } catch (e: unknown) {
      // Best-effort. Don't fail the usage write if the timestamp
      // update doesn't take (e.g. session row missing for some
      // edge-case scenario).
      log.warn(
        `[db] insertUsageEvent: failed to bump session.ended_at for ${u.sessionId}: ${(e as Error).message}`
      );
    }
  }
  // Cost accounting is too important to lose 5 seconds of data on crash. The
  // imported source already had a flush surge during bulk import, but for
  // 'live' events this is one DB write every ~30 seconds (per model call) —
  // cheap relative to the value of accurate budget tracking across restarts.
  if (u.source === 'live') flushNow();
}

// ---- Imported files tracking ----

export function getImportedFile(
  path: string
): { size: number; mtime: number; last_byte_offset: number } | undefined {
  return db()
    .prepare('SELECT size, mtime, last_byte_offset FROM imported_files WHERE path = ?')
    .get<{ size: number; mtime: number; last_byte_offset: number }>(path);
}

export function setImportedFile(args: {
  path: string;
  size: number;
  mtime: number;
  lastByteOffset: number;
}) {
  db()
    .prepare(
      `
      INSERT INTO imported_files (path, size, mtime, last_byte_offset, imported_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        size = excluded.size,
        mtime = excluded.mtime,
        last_byte_offset = excluded.last_byte_offset,
        imported_at = excluded.imported_at
    `
    )
    .run(args.path, args.size, args.mtime, args.lastByteOffset, Date.now());
}

// ---- Settings ----

export function getSetting(key: string): string | null {
  const r = db()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get<{ value: string }>(key);
  return r?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

export function listSettings(): { key: string; value: string }[] {
  return db()
    .prepare('SELECT key, value FROM settings ORDER BY key')
    .all<{ key: string; value: string }>();
}

// ---- Audit events ----

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

export function insertAuditEvent(args: {
  ts: number;
  projectId: string;
  sessionId: string | null;
  tool: string;
  inputJson: string | null;
  outputRef: string | null;
  status: 'ok' | 'error' | 'wait';
  durationMs: number | null;
}) {
  db()
    .prepare(
      `INSERT INTO audit_events
        (ts, project_id, session_id, tool, input_json, output_ref, status, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.ts,
      args.projectId,
      args.sessionId,
      args.tool,
      args.inputJson,
      args.outputRef,
      args.status,
      args.durationMs
    );
}

// ---- API keys ----
//
// Each API key is a separate row. One row is marked is_default = 1 — that's
// the key new sessions get assigned to. Sessions can override their
// api_key_id via the right-click menu. Budget queries optionally filter by
// api_key_id so each key has independent governor accounting.

export interface ApiKeyRow {
  id: string;
  name: string;
  cipher_b64: string;
  daily_budget_usd: number | null;
  per_turn_cap_usd: number | null;
  is_default: number;
  created_at: number;
  /**
   * Signed carry-over from past hours, in USD micros. Positive = unused
   * budget that rolls forward; negative = overspend that subtracts from
   * future hours. Updated atomically by `settleApiKeyAdjustment` on the
   * first budget read in any new hour.
   */
  adjustment_micros: number;
  /**
   * Start-of-hour (ms, local-clock-aligned) that `adjustment_micros` is
   * "as of". Zero means uninitialized — the next settle call anchors it
   * to the current hour with a zero adjustment (clean slate).
   */
  adjustment_hour_ts: number;
}

/**
 * Column list used by every api_keys SELECT. Centralized so adding a
 * new column doesn't require touching five copies of the query string.
 */
const API_KEY_COLS =
  'id, name, cipher_b64, daily_budget_usd, per_turn_cap_usd, is_default, created_at, adjustment_micros, adjustment_hour_ts';

/** All keys, default first. The full set including cipher_b64. */
export function listApiKeysFull(): ApiKeyRow[] {
  return db()
    .prepare(
      `SELECT ${API_KEY_COLS}
         FROM api_keys
        ORDER BY is_default DESC, created_at ASC`
    )
    .all<ApiKeyRow>();
}

/** Look up a single key by id. */
export function getApiKeyRow(id: string): ApiKeyRow | undefined {
  return db()
    .prepare(`SELECT ${API_KEY_COLS} FROM api_keys WHERE id = ?`)
    .get<ApiKeyRow>(id);
}

/** Current default key, or undefined if no keys are configured. */
export function getDefaultApiKeyRow(): ApiKeyRow | undefined {
  // Prefer is_default=1, but if nothing is flagged (e.g. immediately after
  // deleting the default), fall back to the earliest-created row so the
  // app still has a working key.
  return (
    db()
      .prepare(
        `SELECT ${API_KEY_COLS} FROM api_keys WHERE is_default = 1 LIMIT 1`
      )
      .get<ApiKeyRow>() ??
    db()
      .prepare(
        `SELECT ${API_KEY_COLS} FROM api_keys ORDER BY created_at ASC LIMIT 1`
      )
      .get<ApiKeyRow>()
  );
}

/**
 * Persist a settled adjustment for a specific key. Called after the
 * settle-on-read step walks the previous-hour spend into a new
 * `(adjustment_micros, adjustment_hour_ts)` pair. Idempotent: re-running
 * with the same args is a no-op.
 */
export function setApiKeyBudgetAdjustment(
  id: string,
  adjustmentMicros: number,
  adjustmentHourTs: number
): void {
  db()
    .prepare(
      `UPDATE api_keys SET adjustment_micros = ?, adjustment_hour_ts = ? WHERE id = ?`
    )
    .run(Math.round(adjustmentMicros), Math.round(adjustmentHourTs), id);
}

/**
 * Zero out the carry-over adjustment for a key and re-anchor to the
 * current hour. Wired to the Settings "Reset overages/underages" button.
 * Spend history in `usage_events` is left untouched — only the
 * accumulated carry-over is cleared.
 */
export function resetApiKeyBudgetAdjustment(id: string, nowHourTs: number): void {
  db()
    .prepare(
      `UPDATE api_keys SET adjustment_micros = 0, adjustment_hour_ts = ? WHERE id = ?`
    )
    .run(Math.round(nowHourTs), id);
}

// ---- Plans (dynamic, persistent) ---------------------------------------

/**
 * One step within a plan. `id` is stable so step status survives a
 * `Plan{action: update}` call that replaces the steps wholesale —
 * matched by id, status preserved when text changed.
 */
export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  notes?: string;
}

export type PlanState = 'active' | 'completed' | 'abandoned';

export interface PlanRow {
  id: string;
  session_id: string;
  title: string;
  state: PlanState;
  steps: PlanStep[];
  outcome_summary: string | null;
  created_at: number;
  updated_at: number;
}

interface RawPlanRow {
  id: string;
  session_id: string;
  title: string;
  state: PlanState;
  steps_json: string;
  outcome_summary: string | null;
  created_at: number;
  updated_at: number;
}

function parsePlanRow(r: RawPlanRow): PlanRow {
  let steps: PlanStep[] = [];
  try {
    const parsed = JSON.parse(r.steps_json);
    if (Array.isArray(parsed)) steps = parsed.filter((s) => s && typeof s.id === 'string');
  } catch {
    // Corrupted JSON — log and treat as empty plan rather than throw.
    // Worst case the model re-issues a Plan{update} and we recover.
    log.warn(`[db] plan ${r.id} has invalid steps_json; treating as empty`);
  }
  return {
    id: r.id,
    session_id: r.session_id,
    title: r.title,
    state: r.state,
    steps,
    outcome_summary: r.outcome_summary,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const PLAN_COLS =
  'id, session_id, title, state, steps_json, outcome_summary, created_at, updated_at';

/** Active plan for a session, or null. */
export function getActivePlan(sessionId: string): PlanRow | null {
  const row = db()
    .prepare(
      `SELECT ${PLAN_COLS} FROM plans WHERE session_id = ? AND state = 'active' LIMIT 1`
    )
    .get<RawPlanRow>(sessionId);
  return row ? parsePlanRow(row) : null;
}

/** All plans for a session, newest first. */
export function listPlansForSession(sessionId: string): PlanRow[] {
  const rows = db()
    .prepare(
      `SELECT ${PLAN_COLS} FROM plans WHERE session_id = ? ORDER BY created_at DESC`
    )
    .all<RawPlanRow>(sessionId);
  return rows.map(parsePlanRow);
}

/** Insert a brand-new plan in 'active' state. */
export function createPlan(args: {
  id: string;
  sessionId: string;
  title: string;
  steps: PlanStep[];
  ts: number;
}): void {
  db()
    .prepare(
      `INSERT INTO plans (id, session_id, title, state, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(
      args.id,
      args.sessionId,
      args.title,
      JSON.stringify(args.steps),
      args.ts,
      args.ts
    );
}

/** Replace the steps of an existing plan (any state). */
export function updatePlanSteps(args: {
  id: string;
  steps: PlanStep[];
  ts: number;
}): void {
  db()
    .prepare(`UPDATE plans SET steps_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(args.steps), args.ts, args.id);
}

/**
 * Transition a plan to a terminal state with an optional outcome
 * summary. Once a plan is `completed` or `abandoned` it cannot
 * transition again — calling this on a non-active plan is a no-op
 * with a warning.
 */
export function setPlanState(args: {
  id: string;
  state: 'completed' | 'abandoned';
  summary: string | null;
  ts: number;
}): void {
  db()
    .prepare(
      `UPDATE plans SET state = ?, outcome_summary = ?, updated_at = ? WHERE id = ? AND state = 'active'`
    )
    .run(args.state, args.summary, args.ts, args.id);
}

/** Insert a new active plan AFTER finalizing any existing active one. */
export function rotateActivePlan(args: {
  newId: string;
  sessionId: string;
  newTitle: string;
  newSteps: PlanStep[];
  previousOutcome: 'completed' | 'abandoned';
  previousSummary: string | null;
  ts: number;
}): void {
  // Finalize current active (if any), then insert new. Must be
  // atomic so the unique-active-per-session index never sees two
  // active rows.
  const d = db();
  d.exec('BEGIN');
  try {
    d.prepare(
      `UPDATE plans SET state = ?, outcome_summary = ?, updated_at = ? WHERE session_id = ? AND state = 'active'`
    ).run(args.previousOutcome, args.previousSummary, args.ts, args.sessionId);
    d.prepare(
      `INSERT INTO plans (id, session_id, title, state, steps_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`
    ).run(
      args.newId,
      args.sessionId,
      args.newTitle,
      JSON.stringify(args.newSteps),
      args.ts,
      args.ts
    );
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

/** Insert a new API key row. */
export function insertApiKey(args: {
  id: string;
  name: string;
  cipherB64: string;
  dailyBudgetUsd: number | null;
  perTurnCapUsd: number | null;
  isDefault: boolean;
  createdAt: number;
}): void {
  db()
    .prepare(
      `INSERT INTO api_keys (id, name, cipher_b64, daily_budget_usd, per_turn_cap_usd, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.id,
      args.name,
      args.cipherB64,
      args.dailyBudgetUsd,
      args.perTurnCapUsd,
      args.isDefault ? 1 : 0,
      args.createdAt
    );
}

/**
 * Update mutable fields on a key row. Pass undefined to leave a field
 * untouched; null clears the field (only valid for budget columns).
 */
export function updateApiKey(
  id: string,
  patch: {
    name?: string;
    cipherB64?: string;
    dailyBudgetUsd?: number | null;
    perTurnCapUsd?: number | null;
  }
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    args.push(patch.name);
  }
  if (patch.cipherB64 !== undefined) {
    sets.push('cipher_b64 = ?');
    args.push(patch.cipherB64);
  }
  if (patch.dailyBudgetUsd !== undefined) {
    sets.push('daily_budget_usd = ?');
    args.push(patch.dailyBudgetUsd);
  }
  if (patch.perTurnCapUsd !== undefined) {
    sets.push('per_turn_cap_usd = ?');
    args.push(patch.perTurnCapUsd);
  }
  if (sets.length === 0) return;
  args.push(id);
  db().prepare(`UPDATE api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

/**
 * Mark a specific key as default; clear is_default on every other row.
 * The caller is responsible for picking a sensible target — typically the
 * row the user just created or explicitly selected in Settings.
 */
export function setDefaultApiKey(id: string): void {
  const tx = db().transaction(() => {
    db().prepare(`UPDATE api_keys SET is_default = 0 WHERE is_default != 0`).run();
    db().prepare(`UPDATE api_keys SET is_default = 1 WHERE id = ?`).run(id);
    return undefined;
  });
  tx();
}

/**
 * Permanently delete an API key. Sessions that referenced it have their
 * api_key_id cleared (they fall back to the default at runtime). Usage
 * history is kept — deleting a key doesn't make its prior spend disappear
 * from the totals; the spend just becomes "unattributed" in per-key views.
 *
 * If the deleted key was the default and other keys exist, the most
 * recently created remaining key is promoted to default so the app
 * always has one.
 */
export function deleteApiKey(id: string): void {
  const tx = db().transaction(() => {
    const row = db()
      .prepare(`SELECT is_default FROM api_keys WHERE id = ?`)
      .get<{ is_default: number }>(id);
    if (!row) return undefined;
    db().prepare(`UPDATE sessions SET api_key_id = NULL WHERE api_key_id = ?`).run(id);
    // Keep historical usage_events for spend totals; null the api_key_id
    // so per-key views don't double-count under a still-existing key.
    db().prepare(`UPDATE usage_events SET api_key_id = NULL WHERE api_key_id = ?`).run(id);
    db().prepare(`DELETE FROM api_keys WHERE id = ?`).run(id);
    if (row.is_default) {
      const next = db()
        .prepare(`SELECT id FROM api_keys ORDER BY created_at DESC LIMIT 1`)
        .get<{ id: string }>();
      if (next) {
        db().prepare(`UPDATE api_keys SET is_default = 1 WHERE id = ?`).run(next.id);
      }
    }
    return undefined;
  });
  tx();
}

/** Count rows. Used by the legacy-migration "is this the first launch?" check. */
export function countApiKeys(): number {
  const r = db().prepare(`SELECT COUNT(*) AS n FROM api_keys`).get<{ n: number }>();
  return r?.n ?? 0;
}

export function listAuditEvents(opts: {
  sessionId?: string;
  limit?: number;
  beforeId?: number | null;
} = {}): AuditEventRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  if (opts.sessionId) {
    if (opts.beforeId != null) {
      return db()
        .prepare(
          `SELECT * FROM audit_events WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
        )
        .all<AuditEventRow>(opts.sessionId, opts.beforeId, limit);
    }
    return db()
      .prepare(`SELECT * FROM audit_events WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
      .all<AuditEventRow>(opts.sessionId, limit);
  }
  if (opts.beforeId != null) {
    return db()
      .prepare(`SELECT * FROM audit_events WHERE id < ? ORDER BY id DESC LIMIT ?`)
      .all<AuditEventRow>(opts.beforeId, limit);
  }
  return db()
    .prepare(`SELECT * FROM audit_events ORDER BY id DESC LIMIT ?`)
    .all<AuditEventRow>(limit);
}
