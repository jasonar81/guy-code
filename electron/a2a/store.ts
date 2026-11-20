/**
 * Data access for the a2a_* tables (schema in ./schema.ts, design 6.2).
 *
 * Takes a minimal "prepare().run/all/get" handle rather than importing
 * `db.ts`, so the same code runs against the app database (via `db()`) and
 * against a throwaway sql.js database in tests.
 *
 * Secrets rule (design 6.2): no plaintext token is ever written to the DB.
 *   - token_out_ref: the NAME of a secret.ts entry holding the token we send
 *     when calling the peer.
 *   - token_in_hash: SHA-256 of the token the peer sends when calling us. We
 *     look peers up by this hash. That lookup is not constant-time, but what it
 *     could leak through timing is a prefix of a SHA-256 of a 256-bit random
 *     token, which gives an attacker nothing to work with.
 *   - invite secrets are likewise stored only as SHA-256 and compared with
 *     timingSafeEqual.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AgentKind, TaskState, TrustLevel } from './types';
import { isTrustLevel } from './types';

export interface SqlStatement {
  run(...params: unknown[]): void;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
}
export interface SqlHandle {
  prepare(sql: string): SqlStatement;
}

/** secret.ts surface we need. Injected so tests can use an in-memory map. */
export interface SecretPort {
  set(name: string, plain: string): boolean;
  get(name: string): string | null;
  clear(name: string): void;
}

export interface PeerRow {
  peer_id: string;
  display_name: string | null;
  agent_kind: AgentKind | null;
  card_url: string;
  cert_sha256: string;
  trust: TrustLevel;
  trust_prev: TrustLevel | null;
  trust_expires_ts: number | null;
  trust_granted_ts: number | null;
  is_self: number;
  token_out_ref: string | null;
  token_in_hash: string | null;
  card_json: string | null;
  last_seen_ts: number | null;
  created_ts: number | null;
}

export interface TaskRow {
  task_id: string;
  peer_id: string;
  direction: 'in' | 'out';
  context_id: string | null;
  session_id: string | null;
  kind: string | null;
  state: TaskState;
  summary: string | null;
  request_json: string | null;
  last_status_json: string | null;
  artifacts_json: string | null;
  watch_json: string | null;
  created_ts: number | null;
  updated_ts: number | null;
  last_push_ts: number | null;
}

export type InviteCheck = 'ok' | 'unknown' | 'expired' | 'used' | 'bad-secret';

/** How many messageIds we remember per peer for dedup (design 4.2.5). */
const SEEN_PER_PEER = 10_000;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** 256-bit random token, base64url. Used for peer bearer tokens. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function hexEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export class A2AStore {
  constructor(
    private readonly db: SqlHandle,
    private readonly secrets: SecretPort
  ) {}

  // ---- peers ---------------------------------------------------------------

  listPeers(): PeerRow[] {
    return this.db.prepare('SELECT * FROM a2a_peers ORDER BY peer_id').all<PeerRow>();
  }

  getPeer(peerId: string): PeerRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_peers WHERE peer_id = ?').get<PeerRow>(peerId);
  }

  getPeerByCardUrl(cardUrl: string): PeerRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_peers WHERE card_url = ?').get<PeerRow>(cardUrl);
  }

  /** Authenticate an inbound bearer token. Returns the peer or undefined. */
  findPeerByInboundToken(token: string): PeerRow | undefined {
    if (!token) return undefined;
    const h = sha256Hex(token);
    const row = this.db.prepare('SELECT * FROM a2a_peers WHERE token_in_hash = ?').get<PeerRow>(h);
    // Re-check in constant time so correctness never depends on SQL collation.
    if (row && row.token_in_hash && hexEqual(row.token_in_hash, h)) return row;
    return undefined;
  }

  /**
   * Pick a short, unique, lowercase handle from a display name: "Dylan Murphy"
   * -> "dylan", then "dylan-2" if taken. `keepFor` lets a re-pair with the
   * same card URL keep its existing handle.
   */
  allocatePeerId(displayName: string, keepFor?: string): string {
    if (keepFor) {
      const existing = this.getPeerByCardUrl(keepFor);
      if (existing) return existing.peer_id;
    }
    const first = String(displayName || '')
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    const base = (first || 'peer').slice(0, 24);
    let id = base;
    for (let n = 2; this.getPeer(id); n++) id = `${base}-${n}`;
    return id;
  }

  /**
   * Create or replace a peer after a successful pairing. Stores the outbound
   * token in secret storage and only the hash of the inbound one. Re-pairing
   * an existing handle replaces its cert pin and tokens but keeps its trust
   * level, so re-pairing after a key change is not a silent escalation or a
   * surprise downgrade.
   */
  savePairedPeer(args: {
    peerId: string;
    displayName: string;
    agentKind: AgentKind;
    cardUrl: string;
    certSha256: string;
    tokenOut: string;
    tokenIn: string;
    cardJson?: string | null;
    now?: number;
  }): PeerRow {
    const now = args.now ?? Date.now();
    const ref = `a2a.peer.${args.peerId}.tokenOut`;
    if (!this.secrets.set(ref, args.tokenOut)) {
      throw new Error('Could not store the peer token in secure storage (OS keychain unavailable).');
    }
    const prev = this.getPeer(args.peerId);
    const trust: TrustLevel = prev?.trust ?? 'inform';
    this.db
      .prepare(
        `INSERT INTO a2a_peers (peer_id, display_name, agent_kind, card_url, cert_sha256, trust,
           token_out_ref, token_in_hash, card_json, last_seen_ts, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(peer_id) DO UPDATE SET
           display_name = excluded.display_name, agent_kind = excluded.agent_kind,
           card_url = excluded.card_url, cert_sha256 = excluded.cert_sha256,
           token_out_ref = excluded.token_out_ref, token_in_hash = excluded.token_in_hash,
           card_json = excluded.card_json, last_seen_ts = excluded.last_seen_ts`
      )
      .run(
        args.peerId,
        args.displayName,
        args.agentKind,
        args.cardUrl,
        args.certSha256,
        trust,
        ref,
        sha256Hex(args.tokenIn),
        args.cardJson ?? null,
        now,
        prev?.created_ts ?? now
      );
    return this.getPeer(args.peerId)!;
  }

  /** The token we present when calling this peer, from secure storage. */
  getOutboundToken(peer: PeerRow): string | null {
    return peer.token_out_ref ? this.secrets.get(peer.token_out_ref) : null;
  }

  deletePeer(peerId: string): boolean {
    const p = this.getPeer(peerId);
    if (!p) return false;
    if (p.token_out_ref) this.secrets.clear(p.token_out_ref);
    this.db.prepare('DELETE FROM a2a_peers WHERE peer_id = ?').run(peerId);
    this.db.prepare('DELETE FROM a2a_seen_messages WHERE peer_id = ?').run(peerId);
    return true;
  }

  setTrust(peerId: string, trust: TrustLevel, opts: { expiresTs?: number | null; now?: number } = {}): void {
    if (!isTrustLevel(trust)) throw new Error(`invalid trust level: ${String(trust)}`);
    const p = this.getPeer(peerId);
    if (!p) throw new Error(`unknown peer ${peerId}`);
    this.db
      .prepare('UPDATE a2a_peers SET trust = ?, trust_prev = ?, trust_expires_ts = ?, trust_granted_ts = ? WHERE peer_id = ?')
      .run(trust, p.trust, opts.expiresTs ?? null, opts.now ?? Date.now(), peerId);
  }

  touchPeer(peerId: string, now = Date.now()): void {
    this.db.prepare('UPDATE a2a_peers SET last_seen_ts = ? WHERE peer_id = ?').run(now, peerId);
  }

  setPeerCard(peerId: string, cardJson: string): void {
    this.db.prepare('UPDATE a2a_peers SET card_json = ? WHERE peer_id = ?').run(cardJson, peerId);
  }

  // ---- invites -------------------------------------------------------------

  createInvite(ttlMs: number, now = Date.now()): { inviteId: string; inviteSecret: string; expires: number } {
    const inviteId = randomUUID();
    const inviteSecret = randomBytes(16).toString('base64url'); // 128-bit (design 4.3)
    const expires = now + ttlMs;
    this.db
      .prepare('INSERT INTO a2a_invites (invite_id, secret_hash, expires_ts, used_ts, created_ts) VALUES (?, ?, ?, NULL, ?)')
      .run(inviteId, sha256Hex(inviteSecret), expires, now);
    // Housekeeping: invites are tiny, but nothing else ever deletes them.
    this.db.prepare('DELETE FROM a2a_invites WHERE expires_ts < ?').run(now - 24 * 3600_000);
    return { inviteId, inviteSecret, expires };
  }

  /**
   * Check and (on success) burn an invite. Order matters: an unknown id, an
   * already-used invite and an expired one are reported before the secret is
   * compared, and a wrong secret does NOT burn the invite (otherwise anyone who
   * saw the invite id could deny the real redeemer). A 128-bit secret cannot be
   * brute-forced, and /a2a-pair is rate limited per source address anyway.
   */
  consumeInvite(inviteId: string, inviteSecret: string, now = Date.now()): InviteCheck {
    const row = this.db
      .prepare('SELECT secret_hash, expires_ts, used_ts FROM a2a_invites WHERE invite_id = ?')
      .get<{ secret_hash: string; expires_ts: number; used_ts: number | null }>(String(inviteId ?? ''));
    if (!row) return 'unknown';
    if (row.used_ts != null) return 'used';
    if (now > row.expires_ts) return 'expired';
    if (!hexEqual(row.secret_hash, sha256Hex(String(inviteSecret ?? '')))) return 'bad-secret';
    this.db.prepare('UPDATE a2a_invites SET used_ts = ? WHERE invite_id = ?').run(now, inviteId);
    return 'ok';
  }

  // ---- dedup ---------------------------------------------------------------

  /** Task id a previously seen messageId produced, or null if new. */
  seenMessage(peerId: string, messageId: string): string | null {
    const r = this.db
      .prepare('SELECT task_id FROM a2a_seen_messages WHERE peer_id = ? AND message_id = ?')
      .get<{ task_id: string | null }>(peerId, messageId);
    return r ? (r.task_id ?? '') : null;
  }

  recordSeenMessage(peerId: string, messageId: string, taskId: string, now = Date.now()): void {
    this.db
      .prepare('INSERT OR REPLACE INTO a2a_seen_messages (peer_id, message_id, task_id, ts) VALUES (?, ?, ?, ?)')
      .run(peerId, messageId, taskId, now);
    // Bounded memory: keep the newest SEEN_PER_PEER ids per peer. A replay of
    // something older than that is rare enough to accept.
    this.db
      .prepare(
        `DELETE FROM a2a_seen_messages WHERE peer_id = ? AND rowid NOT IN (
           SELECT rowid FROM a2a_seen_messages WHERE peer_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?)`
      )
      .run(peerId, peerId, SEEN_PER_PEER);
  }

  // ---- tasks + contexts ----------------------------------------------------

  insertTask(t: {
    taskId: string;
    peerId: string;
    direction: 'in' | 'out';
    contextId: string | null;
    sessionId: string | null;
    kind: string | null;
    state: TaskState;
    summary: string | null;
    requestJson?: string | null;
    statusJson?: string | null;
    now?: number;
  }): void {
    const now = t.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO a2a_tasks (task_id, peer_id, direction, context_id, session_id, kind, state,
           summary, request_json, last_status_json, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        t.taskId,
        t.peerId,
        t.direction,
        t.contextId,
        t.sessionId,
        t.kind,
        t.state,
        t.summary,
        t.requestJson ?? null,
        t.statusJson ?? null,
        now,
        now
      );
  }

  getTask(taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_tasks WHERE task_id = ?').get<TaskRow>(taskId);
  }

  updateTask(taskId: string, patch: { state?: TaskState; sessionId?: string | null; statusJson?: string | null }, now = Date.now()): void {
    const cur = this.getTask(taskId);
    if (!cur) return;
    this.db
      .prepare('UPDATE a2a_tasks SET state = ?, session_id = ?, last_status_json = ?, updated_ts = ? WHERE task_id = ?')
      .run(
        patch.state ?? cur.state,
        patch.sessionId !== undefined ? patch.sessionId : cur.session_id,
        patch.statusJson !== undefined ? patch.statusJson : cur.last_status_json,
        now,
        taskId
      );
  }

  getContext(contextId: string): { context_id: string; peer_id: string; session_id: string | null } | undefined {
    return this.db
      .prepare('SELECT context_id, peer_id, session_id FROM a2a_contexts WHERE context_id = ?')
      .get<{ context_id: string; peer_id: string; session_id: string | null }>(contextId);
  }

  setContext(contextId: string, peerId: string, sessionId: string | null, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO a2a_contexts (context_id, peer_id, session_id, created_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(context_id) DO UPDATE SET session_id = excluded.session_id`
      )
      .run(contextId, peerId, sessionId, now);
  }
}
