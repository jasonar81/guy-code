/**
 * Data access for rooms (design 11b, schema in ./schema.ts A2A_ROOMS_SQL,
 * migration v18): per-session identities, rooms, rosters, the room inbox and
 * room invites.
 *
 * Secrets rule, as for peers (design 6.2): nothing secret is written to these
 * tables. Session private keys and room keys live in secret storage:
 *   a2a.session.<sessionId>.key              PKCS#8 PEM of the session identity
 *   a2a.room.<owner>.<roomId>.<epoch>        base64 of the 32-byte room key
 * Room invite secrets are stored only as SHA-256 and compared in constant time.
 *
 * `owner` is the local member: a Guy Code session id, or INSTALL_OWNER for
 * the two-member rooms migrated from pairwise peers (they keep the install
 * identity, which is what the other side already pinned).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { hashMatches, sha256Hex, type InviteCheck, type SecretPort, type SqlHandle } from './store';
import { fingerprintOfPem, generateSelfSignedCert, type TlsIdentity } from './tls';

export type RoomStatus = 'active' | 'pending' | 'left';

export interface RoomRow {
  session_id: string;
  room_id: string;
  display_name: string | null;
  relay_url: string | null;
  status: RoomStatus;
  epoch: number;
  trust: string;
  migrated_from: string | null;
  created_ts: number | null;
  joined_ts: number | null;
}

export interface MemberRow {
  session_id: string;
  room_id: string;
  fingerprint: string;
  /** SPKI DER, base64url (relayCrypto.relayPublicKeyOf). */
  public_key: string;
  display_name: string | null;
  session_label: string | null;
  agent_kind: string | null;
  /** The member's install fingerprint (so the UI can say "same Guy Code as you"). */
  install_fp: string | null;
  joined_ts: number | null;
  left_ts: number | null;
}

export interface RoomMessageRow {
  session_id: string;
  room_id: string;
  sender_fp: string;
  msg_id: string;
  type: string | null;
  kind: string | null;
  text: string | null;
  outgoing: number;
  task_id: string | null;
  ts: number | null;
}

const MESSAGES_PER_ROOM = 500;

const sessionKeySecret = (sessionId: string) => `a2a.session.${sessionId}.key`;
const roomKeySecret = (owner: string, roomId: string, epoch: number) => `a2a.room.${owner}.${roomId}.${epoch}`;

export class RoomStore {
  constructor(
    private readonly db: SqlHandle,
    private readonly secrets: SecretPort
  ) {}

  // ---- per-session identities (11b "One identity per session") ---------------

  /** The stored identity, or null when there is none or its key is gone. */
  getIdentity(sessionId: string): TlsIdentity | null {
    const row = this.db.prepare('SELECT cert_pem, fingerprint FROM a2a_session_identities WHERE session_id = ?').get<{ cert_pem: string; fingerprint: string }>(sessionId);
    if (!row) return null;
    const keyPem = this.secrets.get(sessionKeySecret(sessionId));
    if (!keyPem) return null;
    try {
      if (fingerprintOfPem(row.cert_pem) !== row.fingerprint) return null;
    } catch {
      return null;
    }
    return { certPem: row.cert_pem, keyPem, fingerprint: row.fingerprint };
  }

  /** Mint and persist a fresh EC P-256 identity for one session (tls.ts, no new dependency). */
  createIdentity(sessionId: string, now = Date.now()): TlsIdentity {
    const id = generateSelfSignedCert({ commonName: 'guycode-session' });
    if (!this.secrets.set(sessionKeySecret(sessionId), id.keyPem)) throw new Error('Cannot store the session key: OS secure storage is unavailable.');
    this.db
      .prepare('INSERT OR REPLACE INTO a2a_session_identities (session_id, fingerprint, cert_pem, created_ts) VALUES (?, ?, ?, ?)')
      .run(sessionId, id.fingerprint, id.certPem, now);
    return id;
  }

  deleteIdentity(sessionId: string): void {
    this.db.prepare('DELETE FROM a2a_session_identities WHERE session_id = ?').run(sessionId);
    this.secrets.clear(sessionKeySecret(sessionId));
  }

  /** Which session owns this fingerprint (for "which session is this member"). */
  sessionForFingerprint(fp: string): string | null {
    const r = this.db.prepare('SELECT session_id FROM a2a_session_identities WHERE fingerprint = ?').get<{ session_id: string }>(fp);
    return r?.session_id ?? null;
  }

  // ---- rooms --------------------------------------------------------------------

  getRoom(owner: string, roomId: string): RoomRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_rooms WHERE session_id = ? AND room_id = ?').get<RoomRow>(owner, roomId);
  }

  /** Rooms of one owner (or every owner), excluding ones we left unless asked. */
  listRooms(owner?: string, includeLeft = false): RoomRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (owner !== undefined) (where.push('session_id = ?'), args.push(owner));
    if (!includeLeft) where.push("status != 'left'");
    return this.db.prepare(`SELECT * FROM a2a_rooms${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_ts, room_id`).all<RoomRow>(...args);
  }

  /** Distinct owners with at least one live room. */
  listOwners(): string[] {
    return this.db.prepare("SELECT DISTINCT session_id FROM a2a_rooms WHERE status != 'left'").all<{ session_id: string }>().map((r) => r.session_id);
  }

  insertRoom(r: { owner: string; roomId: string; name: string; relayUrl: string | null; status: RoomStatus; epoch: number; trust?: string; migratedFrom?: string | null; now: number }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO a2a_rooms (session_id, room_id, display_name, relay_url, status, epoch, trust, migrated_from, created_ts, joined_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(r.owner, r.roomId, r.name, r.relayUrl, r.status, r.epoch, r.trust ?? 'inform', r.migratedFrom ?? null, r.now, r.status === 'active' ? r.now : null);
  }

  setRoomStatus(owner: string, roomId: string, status: RoomStatus, now = Date.now()): void {
    this.db.prepare(`UPDATE a2a_rooms SET status = ?${status === 'active' ? ', joined_ts = COALESCE(joined_ts, ?)' : ''} WHERE session_id = ? AND room_id = ?`).run(...(status === 'active' ? [status, now, owner, roomId] : [status, owner, roomId]));
  }

  setEpoch(owner: string, roomId: string, epoch: number): void {
    this.db.prepare('UPDATE a2a_rooms SET epoch = ? WHERE session_id = ? AND room_id = ?').run(epoch, owner, roomId);
  }

  /** Forget a room entirely: roster, inbox, invites and every stored key. */
  deleteRoom(owner: string, roomId: string): void {
    const r = this.getRoom(owner, roomId);
    for (let e = 0; r && e <= r.epoch; e++) this.secrets.clear(roomKeySecret(owner, roomId, e));
    for (const t of ['a2a_rooms', 'a2a_room_members', 'a2a_room_messages', 'a2a_room_invites']) {
      this.db.prepare(`DELETE FROM ${t} WHERE session_id = ? AND room_id = ?`).run(owner, roomId);
    }
  }

  setKey(owner: string, roomId: string, epoch: number, key: Buffer): void {
    if (!this.secrets.set(roomKeySecret(owner, roomId, epoch), key.toString('base64'))) throw new Error('Cannot store the room key: OS secure storage is unavailable.');
    // Keep the current and the previous epoch only (messages in flight across a rotation).
    if (epoch >= 2) this.secrets.clear(roomKeySecret(owner, roomId, epoch - 2));
  }

  getKey(owner: string, roomId: string, epoch: number): Buffer | null {
    if (epoch < 0) return null;
    const v = this.secrets.get(roomKeySecret(owner, roomId, epoch));
    if (!v) return null;
    const b = Buffer.from(v, 'base64');
    return b.length === 32 ? b : null;
  }

  // ---- roster ---------------------------------------------------------------------

  listMembers(owner: string, roomId: string, includeLeft = false): MemberRow[] {
    return this.db
      .prepare(`SELECT * FROM a2a_room_members WHERE session_id = ? AND room_id = ?${includeLeft ? '' : ' AND left_ts IS NULL'} ORDER BY joined_ts, fingerprint`)
      .all<MemberRow>(owner, roomId);
  }

  getMember(owner: string, roomId: string, fp: string): MemberRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_room_members WHERE session_id = ? AND room_id = ? AND fingerprint = ?').get<MemberRow>(owner, roomId, fp);
  }

  /** Add (or re-add) a member. A re-added member gets left_ts cleared. */
  upsertMember(owner: string, roomId: string, m: { fp: string; pk: string; name?: string | null; label?: string | null; kind?: string | null; install?: string | null }, now = Date.now()): void {
    const prev = this.getMember(owner, roomId, m.fp);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO a2a_room_members (session_id, room_id, fingerprint, public_key, display_name, session_label, agent_kind, install_fp, joined_ts, left_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(owner, roomId, m.fp, m.pk, m.name ?? null, m.label ?? null, m.kind ?? null, m.install ?? null, prev?.left_ts == null ? prev?.joined_ts ?? now : now);
  }

  markLeft(owner: string, roomId: string, fp: string, now = Date.now()): void {
    this.db.prepare('UPDATE a2a_room_members SET left_ts = ? WHERE session_id = ? AND room_id = ? AND fingerprint = ? AND left_ts IS NULL').run(now, owner, roomId, fp);
  }

  // ---- inbox ----------------------------------------------------------------------

  hasMessage(owner: string, roomId: string, senderFp: string, msgId: string): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM a2a_room_messages WHERE session_id = ? AND room_id = ? AND sender_fp = ? AND msg_id = ?').get(owner, roomId, senderFp, msgId);
  }

  /** Record a message once. Returns false if it was already there (a relay redelivery). */
  recordMessage(m: { owner: string; roomId: string; senderFp: string; msgId: string; type: string; kind?: string | null; text?: string | null; outgoing?: boolean; taskId?: string | null; ts: number }): boolean {
    if (this.hasMessage(m.owner, m.roomId, m.senderFp, m.msgId)) return false;
    this.db
      .prepare(
        `INSERT INTO a2a_room_messages (session_id, room_id, sender_fp, msg_id, type, kind, text, outgoing, task_id, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(m.owner, m.roomId, m.senderFp, m.msgId, m.type, m.kind ?? null, m.text ?? null, m.outgoing ? 1 : 0, m.taskId ?? null, m.ts);
    this.db
      .prepare(
        `DELETE FROM a2a_room_messages WHERE session_id = ? AND room_id = ? AND rowid NOT IN (
           SELECT rowid FROM a2a_room_messages WHERE session_id = ? AND room_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?)`
      )
      .run(m.owner, m.roomId, m.owner, m.roomId, MESSAGES_PER_ROOM);
    return true;
  }

  setMessageTask(owner: string, roomId: string, senderFp: string, msgId: string, taskId: string): void {
    this.db.prepare('UPDATE a2a_room_messages SET task_id = ? WHERE session_id = ? AND room_id = ? AND sender_fp = ? AND msg_id = ?').run(taskId, owner, roomId, senderFp, msgId);
  }

  /** Highest inbox sequence number (rowid) so far: a wait-for-anything starts after it. */
  maxSeq(): number {
    const r = this.db.prepare('SELECT MAX(rowid) AS n FROM a2a_room_messages').get<{ n: number | null }>();
    return Number(r?.n ?? 0);
  }

  /** Incoming content messages after `seq` for these owners (oldest first). */
  incomingSince(owners: string[], seq: number, roomIds: string[] = []): Array<RoomMessageRow & { seq: number }> {
    if (!owners.length) return [];
    const args: unknown[] = [...owners, seq];
    let roomSql = '';
    if (roomIds.length) {
      roomSql = ` AND room_id IN (${roomIds.map(() => '?').join(', ')})`;
      args.push(...roomIds);
    }
    return this.db
      .prepare(
        `SELECT rowid AS seq, * FROM a2a_room_messages WHERE session_id IN (${owners.map(() => '?').join(', ')}) AND rowid > ? AND outgoing = 0
           AND type = 'msg'${roomSql} ORDER BY rowid LIMIT 20`
      )
      .all<RoomMessageRow & { seq: number }>(...args);
  }

  /** Newest last. Only content (msg / reply) unless `all`. */
  listMessages(owners: string[], roomId: string | null, limit = 20, all = false): RoomMessageRow[] {
    if (!owners.length) return [];
    const where = [`session_id IN (${owners.map(() => '?').join(', ')})`];
    const args: unknown[] = [...owners];
    if (roomId) (where.push('room_id = ?'), args.push(roomId));
    if (!all) where.push("type IN ('msg', 'reply')");
    args.push(Math.max(1, Math.min(limit, 200)));
    return this.db
      .prepare(`SELECT * FROM a2a_room_messages WHERE ${where.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all<RoomMessageRow>(...args)
      .reverse();
  }

  // ---- invites (same rules as pairing: single use, short expiry, constant time) ------

  createInvite(owner: string, roomId: string, ttlMs: number, now = Date.now()): { inviteId: string; inviteSecret: string; expires: number } {
    const inviteId = randomUUID();
    const inviteSecret = randomBytes(16).toString('base64url'); // 128-bit, like pairing
    const expires = now + ttlMs;
    this.db
      .prepare('INSERT INTO a2a_room_invites (invite_id, session_id, room_id, secret_hash, expires_ts, used_ts, created_ts) VALUES (?, ?, ?, ?, ?, NULL, ?)')
      .run(inviteId, owner, roomId, sha256Hex(inviteSecret), expires, now);
    this.db.prepare('DELETE FROM a2a_room_invites WHERE expires_ts < ?').run(now - 24 * 3600_000);
    return { inviteId, inviteSecret, expires };
  }

  /**
   * Check and (on success) burn a room invite. As store.consumeInvite: unknown,
   * used and expired are reported before the secret is compared, and a wrong
   * secret does NOT burn the invite. The invite must belong to this owner and room.
   */
  consumeInvite(owner: string, roomId: string, inviteId: string, inviteSecret: string, now = Date.now()): InviteCheck {
    const row = this.db
      .prepare('SELECT secret_hash, expires_ts, used_ts FROM a2a_room_invites WHERE invite_id = ? AND session_id = ? AND room_id = ?')
      .get<{ secret_hash: string; expires_ts: number; used_ts: number | null }>(String(inviteId ?? ''), owner, roomId);
    if (!row) return 'unknown';
    if (row.used_ts != null) return 'used';
    if (now > row.expires_ts) return 'expired';
    if (!hashMatches(row.secret_hash, String(inviteSecret ?? ''))) return 'bad-secret';
    this.db.prepare('UPDATE a2a_room_invites SET used_ts = ? WHERE invite_id = ?').run(now, inviteId);
    return 'ok';
  }
}
