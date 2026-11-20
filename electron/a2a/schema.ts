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
 *   - `sessions.wait_a2a` is NOT added here. It belongs to WaitForA2A (P2) and
 *     needs an ALTER TABLE, which cannot be written idempotently.
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
