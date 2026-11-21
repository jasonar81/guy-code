/**
 * DDL for the A2A tables (design 6.2). Kept dependency-free so `db.ts` can
 * apply it as a normal numbered migration AND the A2A tests can apply the
 * exact same SQL to a throwaway sql.js database, which keeps the tests honest
 * about the real schema.
 *
 * Deviations from 6.2, each deliberate:
 *   - `a2a_seen_messages.task_id`: dedup must return the ORIGINAL task for a
 *     replayed messageId (idempotent retries), so we need to know which one.
 *   - `a2a_invites`: pairing invites must survive an app restart (a code sent
 *     over Slack may be redeemed ten minutes later), and the invite secret is
 *     stored only as a SHA-256 so a DB copy cannot be used to pair.
 *   - `sessions.wait_a2a` is NOT in this SQL. It is added by the P2 column
 *     list below, through a guarded ALTER TABLE.
 */
export const A2A_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS a2a_peers (
    peer_id TEXT PRIMARY KEY,
    display_name TEXT,
    agent_kind TEXT,
    card_url TEXT NOT NULL,
    cert_sha256 TEXT NOT NULL,
    trust TEXT NOT NULL DEFAULT 'inform',
    trust_prev TEXT,
    trust_expires_ts INTEGER,
    trust_granted_ts INTEGER,
    is_self INTEGER DEFAULT 0,
    token_out_ref TEXT,
    token_in_hash TEXT,
    card_json TEXT,
    last_seen_ts INTEGER,
    created_ts INTEGER
  );
  CREATE INDEX IF NOT EXISTS a2a_peers_token_in ON a2a_peers(token_in_hash);
  CREATE TABLE IF NOT EXISTS a2a_tasks (
    task_id TEXT PRIMARY KEY,
    peer_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    context_id TEXT,
    session_id TEXT,
    kind TEXT,
    state TEXT NOT NULL,
    summary TEXT,
    request_json TEXT,
    last_status_json TEXT,
    artifacts_json TEXT,
    watch_json TEXT,
    created_ts INTEGER,
    updated_ts INTEGER,
    last_push_ts INTEGER
  );
  CREATE INDEX IF NOT EXISTS a2a_tasks_peer ON a2a_tasks(peer_id, direction);
  CREATE TABLE IF NOT EXISTS a2a_contexts (
    context_id TEXT PRIMARY KEY,
    peer_id TEXT,
    session_id TEXT,
    created_ts INTEGER
  );
  CREATE TABLE IF NOT EXISTS a2a_push_configs (
    config_id TEXT PRIMARY KEY,
    task_id TEXT,
    url TEXT,
    token TEXT,
    auth_json TEXT
  );
  CREATE TABLE IF NOT EXISTS a2a_outbox (
    id INTEGER PRIMARY KEY,
    peer_id TEXT,
    kind TEXT,
    payload_json TEXT,
    attempts INTEGER,
    next_try_ts INTEGER,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS a2a_seen_messages (
    peer_id TEXT,
    message_id TEXT,
    task_id TEXT,
    ts INTEGER,
    PRIMARY KEY (peer_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS a2a_invites (
    invite_id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    expires_ts INTEGER NOT NULL,
    used_ts INTEGER,
    created_ts INTEGER
  );
`;

/**
 * P2 columns (tasks, push, outbox, waiting). SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so each one is added only when PRAGMA
 * table_info says it is missing (`applyA2AP2Schema`). That keeps the
 * migration safe to re-run and lets the tests apply exactly the same change.
 *
 *   sessions.wait_a2a          JSON WaitForA2A state, parallel to wait_condition (design 6.4).
 *   a2a_tasks.push_token_hash  OUT tasks: SHA-256 of the per-task push token we
 *                              issued. An inbound push must present the token that
 *                              hashes to this (design 4.2.5); the plaintext is never stored.
 *   a2a_tasks.approval         IN tasks from an `inform` peer: 'pending' until the
 *                              user accepts ('accepted') or declines ('declined').
 *   a2a_outbox.task_id         The task a queued push is about (so a newer snapshot
 *                              replaces an older one that has not gone out yet).
 *   a2a_outbox.created_ts / expires_ts
 *                              Retry window: 24 hours from the first attempt (design 6.6).
 *
 * a2a_push_configs needs no new column. Its `token` column stays NULL: the
 * per-task push token we must present to a peer lives in secret storage, and
 * `auth_json` records the scheme plus the secret's name.
 */
export const A2A_P2_COLUMNS: ReadonlyArray<readonly [table: string, column: string, type: string]> = [
  ['sessions', 'wait_a2a', 'TEXT'],
  ['a2a_tasks', 'push_token_hash', 'TEXT'],
  ['a2a_tasks', 'approval', 'TEXT'],
  ['a2a_outbox', 'task_id', 'TEXT'],
  ['a2a_outbox', 'created_ts', 'INTEGER'],
  ['a2a_outbox', 'expires_ts', 'INTEGER'],
];

export const A2A_P2_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS a2a_outbox_due ON a2a_outbox(next_try_ts);
  CREATE INDEX IF NOT EXISTS a2a_push_configs_task ON a2a_push_configs(task_id);
`;

/**
 * Apply the P2 columns and indexes. `columnsOf` returns the existing column
 * names of a table, or [] when the table does not exist (the A2A tests have no
 * `sessions` table; that column is then simply skipped).
 */
export function applyA2AP2Schema(exec: (sql: string) => void, columnsOf: (table: string) => string[]): void {
  addMissingColumns(exec, columnsOf, A2A_P2_COLUMNS);
  exec(A2A_P2_INDEX_SQL);
}

function addMissingColumns(
  exec: (sql: string) => void,
  columnsOf: (table: string) => string[],
  list: ReadonlyArray<readonly [string, string, string]>
): void {
  for (const [table, column, type] of list) {
    const cols = columnsOf(table);
    if (cols.length === 0 || cols.includes(column)) continue;
    exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}

/**
 * P3 (watch extension, design 5.5). `a2a_tasks.watch_json` already exists
 * from P1 and holds the watch state (command, shell, interval, deadline,
 * onMet...). P3 adds one column:
 *
 *   a2a_tasks.watch_next_ts  When the watch's check next runs (epoch ms), or
 *                            NULL when the task has no live watch. Indexed so
 *                            the sweep after a restart finds due watches
 *                            without parsing every task's JSON. Kept out of
 *                            the JSON so the "is anything due?" query is a
 *                            plain range scan.
 */
export const A2A_P3_COLUMNS: ReadonlyArray<readonly [table: string, column: string, type: string]> = [
  ['a2a_tasks', 'watch_next_ts', 'INTEGER'],
];

export const A2A_P3_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS a2a_tasks_watch_next ON a2a_tasks(watch_next_ts);
`;

/** Apply the P3 column and index. Guarded and re-runnable, like `applyA2AP2Schema`. */
export function applyA2AP3Schema(exec: (sql: string) => void, columnsOf: (table: string) => string[]): void {
  addMissingColumns(exec, columnsOf, A2A_P3_COLUMNS);
  exec(A2A_P3_INDEX_SQL);
}
