/**
 * Rooms (docs/a2a/DESIGN.md 11b, 11c): the client side.
 *
 * A room is a mailbox on the relay with a random id and a shared 32-byte key.
 * Membership is by SESSION: each Guy Code session that is in a room has its
 * own EC P-256 identity (roomStore.ts, 11b "One identity per session") and
 * its own relay connection, because the relay keeps one stream per
 * fingerprint and two sessions sharing the install cert evict each other.
 * That is what lets two sessions of ONE install sit in the same room.
 *
 * The relay is untrusted: it only fans out ciphertext. Every post is sealed
 * with the room key AND signed by the sender's own key (roomCrypto.ts); a
 * post whose signature does not verify against our roster is dropped and
 * audited, and never reaches a model.
 *
 * Membership changes, all signed room posts:
 *   join   joiner -> room, sealed with the key from the invite code. Only the
 *          member who issued the code acts on it: it burns the invite (single
 *          use, expiry, constant-time compare - roomStore.consumeInvite) and
 *          checks the joiner's certificate carries the key it signed with.
 *   admit  inviter -> room: the new roster plus a NEW key (epoch + 1) boxed
 *          for each member, so the key printed in the code dies with its use.
 *   deny   inviter -> room: the code was used, expired or wrong.
 *   rekey  remover -> room: the removed member is marked gone and a NEW key is
 *          boxed for each remaining member. The removed member still holds the
 *          old key and so reads nothing posted afterwards.
 *   leave  leaver -> room, then a relay leave.
 *
 * The relay forgets every room when it restarts and does not say so, so each
 * session re-joins all its rooms after every login (join is idempotent).
 * Every room post is acknowledged (POST /relay/v1/ack) whatever we did with
 * it, or the relay would redeliver it each time the stream drops.
 *
 * Migrated pairwise peers (11b "Migration") are two-member rooms owned by the
 * install identity (INSTALL_OWNER) whose transport stays the existing pairing
 * link, so trust levels, approvals, push and the Claude Code plugin keep
 * working unchanged until the plugin speaks rooms (step 3).
 */
import { createHash } from 'node:crypto';
import type { AuditLog } from './audit';
import { LIMITS, normaliseRelayUrl } from './config';
import { buildEnvelope, type EnvelopeDialect } from './envelope';
import { RelayClient, RelayUnavailableError, type RoomEnvelope } from './relayClient';
import { relayAvailableForPeer, relayPublicKeyOf } from './relayCrypto';
import { deliveryMode, type SessionPort } from './router';
import type { PeerRow } from './store';
import type { TlsIdentity } from './tls';
import type { AgentKind, MessageKind, TrustLevel } from './types';
import { INSTALL_OWNER, type Waiters } from './waiters';
import {
  ROOM_CODE_RE,
  certMatches,
  decodeRoomCode,
  encodeRoomCode,
  epochOfMsgId,
  newMsgId,
  newRoomId,
  newRoomKey,
  openBox,
  openRoomMessage,
  sealBox,
  sealRoomMessage,
  verifyBody,
  type RoomBody,
  type RosterEntry,
  type SignedBody,
} from './roomCrypto';
import type { MemberRow, RoomMessageRow, RoomRow, RoomStore } from './roomStore';
import type { RelayNodeOptions } from './node';

/** How long `redeem` waits for the inviter's admit before reporting "pending". */
const JOIN_WAIT_MS = 20_000;
const CONNECT_WAIT_MS = 10_000;

/** What the manager needs from A2ANode (kept narrow so it stays testable). */
export interface RoomHost {
  readonly rooms: RoomStore;
  readonly audit: AuditLog;
  readonly waiters: Waiters;
  readonly sessions: SessionPort;
  now(): number;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
  displayName: string;
  agentKind: AgentKind;
  dialect?: EnvelopeDialect;
  installIdentity(): TlsIdentity | null;
  relayOptions(): RelayNodeOptions | null;
  sessionLabel(sessionId: string): string | null;
  /** An inbound request / notify from a room member: make an IN task, return its id. */
  createInTask(a: { owner: string; room: RoomRow; kind: MessageKind; text: string; senderFp: string; requesterTaskId: string | null }): string;
  /** A member answered one of our room requests. */
  applyReply(a: { owner: string; room: RoomRow; taskId: string; state: string | null; text: string; who: string; msgId: string }): void;
  /** Send over the existing pairing link (migrated two-member rooms). */
  pairSend(peerId: string, kind: MessageKind, text: string, sessionId?: string): Promise<{ taskId: string; line: string }>;
  changed(): void;
}

export interface PostResult {
  room: RoomRow;
  msgId: string;
  delivered: number;
  queued: number;
  dropped: Array<{ to: string; reason: string }>;
  taskId?: string;
  /** Set for a migrated pair room: what the pairing link said. */
  line?: string;
}

export interface RoomView {
  owner: string;
  room: RoomRow;
  members: Array<MemberRow & { you: boolean; localSession: string | null; sameInstall: boolean }>;
}

function short(fp: string): string {
  return fp.slice(0, 8);
}

/** A one-word handle for a member, safe for an envelope header. */
export function memberHandle(m: Pick<MemberRow, 'display_name' | 'fingerprint'>): string {
  const first = String(m.display_name ?? '').trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9_-]/g, '') ?? '';
  return `${first || 'member'}-${short(m.fingerprint).slice(0, 4)}`;
}

/** "Dylan (session "loader fix")" for humans. */
export function memberLabel(m: Pick<MemberRow, 'display_name' | 'session_label' | 'fingerprint'>): string {
  const name = (m.display_name || '').trim() || `member ${short(m.fingerprint)}`;
  return m.session_label ? `${name} (session "${m.session_label}")` : name;
}

/** Room id for a migrated pair: the same on both sides (sorted fingerprints). */
export function pairRoomId(a: string, b: string): string {
  return 'pair-' + createHash('sha256').update([a, b].sort().join(':')).digest('hex').slice(0, 40);
}

export class RoomManager {
  private readonly clients = new Map<string, RelayClient>();
  private readonly pendingJoins = new Map<string, { resolve(): void; reject(e: Error): void }>();
  private relayCfg: RelayNodeOptions | null = null;

  constructor(private readonly h: RoomHost) {}

  // ---- connections --------------------------------------------------------------

  /** (Re)start a relay connection for every session that has rooms. */
  start(cfg: RelayNodeOptions | null): void {
    this.stop();
    this.relayCfg = cfg && normaliseRelayUrl(cfg.url) ? cfg : null;
    if (!this.relayCfg) return;
    let owners: string[] = [];
    try {
      owners = this.h.rooms.listOwners();
    } catch {
      // No rooms tables in this database (the Claude Code plugin daemon,
      // until step 3): rooms are simply unavailable, nothing else changes.
      return;
    }
    for (const owner of owners) if (owner !== INSTALL_OWNER) this.client(owner);
  }

  stop(): void {
    for (const c of this.clients.values()) c.stop();
    this.clients.clear();
    for (const [k, p] of this.pendingJoins) {
      this.pendingJoins.delete(k);
      p.reject(new Error('A2A stopped before the join finished.'));
    }
  }

  /** The live connection for one session (tests, diagnostics). */
  clientFor(owner: string): RelayClient | null {
    return this.clients.get(owner) ?? null;
  }

  /** This session's identity, minted on first use and reused across restarts. */
  identity(owner: string): TlsIdentity {
    if (owner === INSTALL_OWNER) {
      const id = this.h.installIdentity();
      if (!id) throw new Error('A2A has no TLS identity.');
      return id;
    }
    const have = this.h.rooms.getIdentity(owner);
    if (have) return have;
    const id = this.h.rooms.createIdentity(owner, this.h.now());
    this.h.audit.write({ event: 'room.identity', sessionId: owner, fingerprint: short(id.fingerprint) });
    return id;
  }

  private client(owner: string): RelayClient {
    const have = this.clients.get(owner);
    if (have) return have;
    const cfg = this.relayCfg;
    if (!cfg) throw new Error('Rooms need the relay. Turn it on in the Agents panel (relay URL) first.');
    const id = this.identity(owner);
    const c = new RelayClient({
      url: normaliseRelayUrl(cfg.url),
      identity: { certPem: id.certPem, keyPem: id.keyPem, fingerprint: id.fingerprint },
      relayCertSha256: cfg.certSha256 || null,
      onPinLearned: (fp) => cfg.onPinLearned?.(fp),
      // A session identity takes part in rooms only: no pairing, no direct requests.
      keyFor: () => null,
      handle: async () => ({ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'This identity only takes part in rooms.' } } }),
      onRoomEnvelope: (env) => this.onEnvelope(owner, env),
      onReady: () => void this.rejoinAll(owner),
      onDropped: (n) => this.h.audit.write({ event: 'relay.dropped', sessionId: owner, msgId: n.msgId.slice(0, 16), reason: n.reason }),
      onStatus: () => this.h.changed(),
      replyWaitMs: cfg.replyWaitMs,
      backoff: cfg.backoff,
      staleMs: cfg.staleMs,
      log: this.h.log,
    });
    this.clients.set(owner, c);
    c.start();
    return c;
  }

  private async connected(owner: string, ms = CONNECT_WAIT_MS): Promise<RelayClient> {
    const c = this.client(owner);
    const end = Date.now() + ms;
    while (!c.isConnected()) {
      if (Date.now() > end) throw new RelayUnavailableError(`Not connected to the relay${c.status().lastError ? ` (${c.status().lastError})` : ''}. Try again in a moment.`);
      await new Promise((r) => setTimeout(r, 25));
    }
    return c;
  }

  /** After every login: the relay may have restarted and forgotten every room. */
  private async rejoinAll(owner: string): Promise<void> {
    const c = this.clients.get(owner);
    if (!c) return;
    const rooms = this.h.rooms.listRooms(owner);
    for (const r of rooms) {
      try {
        await c.joinRoom(r.room_id);
      } catch (e) {
        this.h.log?.warn(`[a2a] re-joining room ${r.room_id.slice(0, 6)} failed: ${(e as Error).message}`);
      }
    }
    if (rooms.length) this.h.audit.write({ event: 'room.rejoin', sessionId: owner, rooms: rooms.length });
    this.h.changed();
  }

  // ---- lookup ---------------------------------------------------------------------

  /** Resolve a room this session can use, by id, id prefix or name. Includes migrated pair rooms. */
  resolve(owner: string, ref: string): RoomRow {
    const q = String(ref ?? '').trim().toLowerCase().replace(/^#/, '');
    const all = [...this.h.rooms.listRooms(owner), ...(owner === INSTALL_OWNER ? [] : this.h.rooms.listRooms(INSTALL_OWNER))];
    if (!all.length) throw new Error('This session is in no rooms yet. Create one (A2ARoom action "create") or join one with an invite code.');
    if (!q) {
      if (all.length === 1) return all[0];
      throw new Error(`Which room? This session is in: ${all.map((r) => `"${r.display_name}"`).join(', ')}.`);
    }
    const exact = all.find((r) => r.room_id.toLowerCase() === q || (r.display_name ?? '').toLowerCase() === q);
    if (exact) return exact;
    const hits = all.filter((r) => r.room_id.toLowerCase().startsWith(q) || (r.display_name ?? '').toLowerCase().includes(q) || (r.migrated_from ?? '') === q);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${ref}" matches several rooms: ${hits.map((r) => `"${r.display_name}"`).join(', ')}.`);
    throw new Error(`No room "${ref}" for this session. Rooms: ${all.map((r) => `"${r.display_name}"`).join(', ')}.`);
  }

  private selfEntry(owner: string): RosterEntry {
    const id = this.identity(owner);
    const inst = this.h.installIdentity();
    return {
      fp: id.fingerprint,
      pk: relayPublicKeyOf(id.certPem),
      name: this.h.displayName,
      label: owner === INSTALL_OWNER ? null : this.h.sessionLabel(owner),
      kind: this.h.agentKind,
      install: inst?.fingerprint ?? null,
    };
  }

  private toEntry(m: MemberRow): RosterEntry {
    return { fp: m.fingerprint, pk: m.public_key, name: m.display_name, label: m.session_label, kind: m.agent_kind, install: m.install_fp };
  }

  private upsert(owner: string, roomId: string, e: RosterEntry): void {
    this.h.rooms.upsertMember(owner, roomId, { fp: e.fp, pk: e.pk, name: e.name ? String(e.name).slice(0, 80) : null, label: e.label ? String(e.label).slice(0, 80) : null, kind: e.kind ?? null, install: e.install ?? null }, this.h.now());
  }

  // ---- create / invite / join / leave / remove ---------------------------------------

  async create(owner: string, name: string): Promise<RoomRow> {
    if (owner === INSTALL_OWNER) throw new Error('Rooms belong to a session.');
    const display = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!display) throw new Error('Give the room a name, e.g. "loader fix".');
    if (!this.relayCfg) throw new Error('Rooms need the relay. Turn it on in the Agents panel (relay URL) first.');
    const roomId = newRoomId();
    const now = this.h.now();
    this.h.rooms.insertRoom({ owner, roomId, name: display, relayUrl: normaliseRelayUrl(this.relayCfg.url), status: 'active', epoch: 0, now });
    this.h.rooms.setKey(owner, roomId, 0, newRoomKey());
    this.upsert(owner, roomId, this.selfEntry(owner));
    this.h.audit.write({ event: 'room.created', sessionId: owner, room: roomId.slice(0, 6), name: display });
    try {
      const c = await this.connected(owner);
      await c.joinRoom(roomId);
    } catch (e) {
      // Created locally; the join happens on the next login (rejoinAll).
      this.h.log?.warn(`[a2a] room created, relay join deferred: ${(e as Error).message}`);
    }
    this.h.changed();
    return this.h.rooms.getRoom(owner, roomId)!;
  }

  /** A single-use invite code carrying room id, relay URL, the current key and roster. */
  invite(owner: string, ref: string): { code: string; expires: number; room: RoomRow } {
    const room = this.resolve(owner, ref);
    if (room.migrated_from) throw new Error(`"${room.display_name}" is a paired conversation; create a new room to add more people.`);
    if (room.session_id !== owner || room.status !== 'active') throw new Error(`This session cannot invite to "${room.display_name}".`);
    const key = this.h.rooms.getKey(owner, room.room_id, room.epoch);
    if (!key) throw new Error('The room key is missing on this machine; this session cannot invite. Leave and re-join the room.');
    const me = this.identity(owner);
    const inv = this.h.rooms.createInvite(owner, room.room_id, LIMITS.inviteTtlMs, this.h.now());
    const roster = this.h.rooms.listMembers(owner, room.room_id).map((m) => this.toEntry(m));
    const code = encodeRoomCode({
      v: 1,
      room: room.room_id,
      name: room.display_name ?? '',
      relay: room.relay_url ?? normaliseRelayUrl(this.relayCfg?.url),
      key: key.toString('base64url'),
      epoch: room.epoch,
      inviteId: inv.inviteId,
      secret: inv.inviteSecret,
      expires: inv.expires,
      by: me.fingerprint,
      roster,
    });
    this.h.audit.write({ event: 'room.invite', sessionId: owner, room: room.room_id.slice(0, 6), inviteId: inv.inviteId, expires: inv.expires });
    return { code, expires: inv.expires, room };
  }

  /**
   * Redeem an invite. Resolves "active" once the inviter admits us, or
   * "pending" if the inviter is offline (the relay holds our join and the
   * room becomes active when they come back).
   */
  async redeem(owner: string, code: string, waitMs = JOIN_WAIT_MS): Promise<{ room: RoomRow; status: 'active' | 'pending' }> {
    if (owner === INSTALL_OWNER) throw new Error('Rooms belong to a session.');
    const p = decodeRoomCode(code);
    if (this.h.now() > p.expires) throw new Error('That room invite has expired. Ask for a fresh one.');
    const cfgUrl = normaliseRelayUrl(this.relayCfg?.url);
    if (!cfgUrl) throw new Error(`Rooms need the relay. Set the relay URL to ${p.relay} in the Agents panel first.`);
    if (normaliseRelayUrl(p.relay) !== cfgUrl) throw new Error(`That room lives on relay ${p.relay}, but this Guy Code uses ${cfgUrl}.`);
    const me = this.identity(owner);
    if (p.roster.some((m) => m.fp === me.fingerprint)) throw new Error('This session is already in that room.');
    const existing = this.h.rooms.getRoom(owner, p.room);
    if (existing?.status === 'active') throw new Error('This session is already in that room.');
    const now = this.h.now();
    this.h.rooms.insertRoom({ owner, roomId: p.room, name: p.name || 'room', relayUrl: cfgUrl, status: 'pending', epoch: p.epoch, now });
    this.h.rooms.setKey(owner, p.room, p.epoch, Buffer.from(p.key, 'base64url'));
    for (const m of p.roster) this.upsert(owner, p.room, m);
    const done = new Promise<void>((resolve, reject) => this.pendingJoins.set(`${owner}|${p.room}`, { resolve, reject }));
    done.catch(() => {});
    try {
      const c = await this.connected(owner);
      await c.joinRoom(p.room);
      await this.send(owner, this.h.rooms.getRoom(owner, p.room)!, { type: 'join', to: p.by, inviteId: p.inviteId, inviteSecret: p.secret, member: this.selfEntry(owner), certPem: me.certPem }, p.epoch);
    } catch (e) {
      this.pendingJoins.delete(`${owner}|${p.room}`);
      this.h.rooms.deleteRoom(owner, p.room);
      throw e;
    }
    this.h.audit.write({ event: 'room.joined', sessionId: owner, room: p.room.slice(0, 6), status: 'requested' });
    let status: 'active' | 'pending' = 'pending';
    const t = new Promise<void>((r) => setTimeout(r, waitMs).unref?.());
    await Promise.race([done.then(() => void (status = 'active')), t]);
    this.h.changed();
    return { room: this.h.rooms.getRoom(owner, p.room) ?? (await done.then(() => this.h.rooms.getRoom(owner, p.room)!)), status };
  }

  /** Leave: tell the room (signed), leave at the relay, forget the key and roster. */
  async leave(owner: string, ref: string): Promise<RoomRow> {
    const room = this.resolve(owner, ref);
    if (room.migrated_from) throw new Error(`"${room.display_name}" is a paired conversation; to end it, unpair ${room.migrated_from} (A2APair action "revoke").`);
    if (room.session_id !== owner) throw new Error(`This session is not a member of "${room.display_name}".`);
    try {
      if (room.status === 'active') await this.send(owner, room, { type: 'leave' }, room.epoch);
    } catch {
      /* offline: the relay leave below (or the others' removal) still applies */
    }
    try {
      await this.clients.get(owner)?.leaveRoom(room.room_id);
    } catch {
      /* best effort */
    }
    this.h.rooms.deleteRoom(owner, room.room_id);
    this.h.audit.write({ event: 'room.left', sessionId: owner, room: room.room_id.slice(0, 6), name: room.display_name });
    this.dropIdleClient(owner);
    this.h.changed();
    return room;
  }

  /** Remove another member and ROTATE the key (a roster change alone is theatre). */
  async remove(owner: string, ref: string, memberRef: string): Promise<{ room: RoomRow; member: MemberRow }> {
    const room = this.resolve(owner, ref);
    if (room.migrated_from) throw new Error(`"${room.display_name}" is a paired conversation; unpair instead.`);
    if (room.session_id !== owner || room.status !== 'active') throw new Error(`This session cannot change "${room.display_name}".`);
    const me = this.identity(owner);
    const member = this.resolveMember(owner, room, memberRef);
    if (member.fingerprint === me.fingerprint) throw new Error('To remove this session, leave the room instead.');
    this.h.rooms.markLeft(owner, room.room_id, member.fingerprint, this.h.now());
    await this.rotate(owner, room, { type: 'rekey', removed: [member.fingerprint] });
    this.h.audit.write({ event: 'room.member_removed', sessionId: owner, room: room.room_id.slice(0, 6), member: short(member.fingerprint), by: 'self' });
    this.h.changed();
    return { room: this.h.rooms.getRoom(owner, room.room_id)!, member };
  }

  resolveMember(owner: string, room: RoomRow, ref: string): MemberRow {
    const q = String(ref ?? '').trim().toLowerCase();
    const ms = this.h.rooms.listMembers(room.session_id, room.room_id);
    const hits = ms.filter(
      (m) =>
        m.fingerprint.startsWith(q) ||
        memberHandle(m) === q ||
        (m.display_name ?? '').toLowerCase() === q ||
        (m.display_name ?? '').toLowerCase().split(/\s+/)[0] === q ||
        (m.session_label ?? '').toLowerCase() === q
    );
    if (q && hits.length === 1) return hits[0];
    const list = ms.map((m) => `${memberHandle(m)} = ${memberLabel(m)}`).join('; ');
    throw new Error(hits.length > 1 ? `"${ref}" matches several members: ${list}. Use the handle.` : `No member "${ref}" in "${room.display_name}". Members: ${list}.`);
  }

  /**
   * New key at epoch + 1, boxed for every remaining member except us, posted
   * sealed with the OLD key (so a member just admitted - who only has the
   * old key from the code - can read its box), then switched to locally.
   */
  private async rotate(owner: string, room: RoomRow, body: { type: 'rekey'; removed: string[] } | { type: 'admit'; member: RosterEntry }): Promise<void> {
    const me = this.identity(owner);
    const epoch = room.epoch + 1;
    const key = newRoomKey();
    const boxes: Record<string, ReturnType<typeof sealBox>> = {};
    const members = this.h.rooms.listMembers(owner, room.room_id);
    for (const m of members) {
      if (m.fingerprint === me.fingerprint) continue;
      boxes[m.fingerprint] = sealBox(me.keyPem, me.fingerprint, this.toEntry(m), { key: key.toString('base64'), epoch });
    }
    const full: RoomBody =
      body.type === 'rekey'
        ? { type: 'rekey', epoch, removed: body.removed, boxes }
        : { type: 'admit', member: body.member, roster: members.map((m) => this.toEntry(m)), epoch, boxes };
    // Switch locally first: if the post fails, the room carries on under the
    // new key and the others get it with the next rotation or a re-invite.
    this.h.rooms.setKey(owner, room.room_id, epoch, key);
    this.h.rooms.setEpoch(owner, room.room_id, epoch);
    await this.send(owner, room, full, room.epoch);
    this.h.audit.write({ event: 'room.rekeyed', sessionId: owner, room: room.room_id.slice(0, 6), epoch, reason: body.type });
  }

  /** A session was deleted: leave its rooms (best effort) and drop its identity. */
  async forgetSession(owner: string): Promise<void> {
    if (owner === INSTALL_OWNER) return;
    for (const r of this.h.rooms.listRooms(owner, true)) {
      await Promise.race([this.leave(owner, r.room_id).catch(() => this.h.rooms.deleteRoom(owner, r.room_id)), new Promise((res) => setTimeout(res, 3000))]);
      this.h.rooms.deleteRoom(owner, r.room_id);
    }
    this.clients.get(owner)?.stop();
    this.clients.delete(owner);
    this.h.rooms.deleteIdentity(owner);
  }

  private dropIdleClient(owner: string): void {
    if (this.h.rooms.listRooms(owner).length) return;
    this.clients.get(owner)?.stop();
    this.clients.delete(owner);
  }

  // ---- posting --------------------------------------------------------------------

  /** Seal (with `epoch`'s key), sign and post one body. */
  private async send(owner: string, room: RoomRow, body: RoomBody, epoch: number): Promise<{ msgId: string; delivered: number; queued: number; dropped: Array<{ to: string; reason: string }> }> {
    const me = this.identity(owner);
    const key = this.h.rooms.getKey(owner, room.room_id, epoch);
    if (!key) throw new Error('The room key is missing on this machine. Leave and re-join the room.');
    const msgId = newMsgId(epoch);
    const signed = { ...body, room: room.room_id, msgId, from: me.fingerprint, ts: this.h.now() } as SignedBody;
    const c = await this.connected(owner, 5_000);
    const r = await c.postRoom(room.room_id, msgId, sealRoomMessage(key, signed, me.keyPem));
    return { msgId, ...r };
  }

  /** Post a message (inform / request / notify) to a room. `taskId` = our OUT task for a request. */
  async post(owner: string, ref: string | RoomRow, a: { text: string; kind?: MessageKind; taskId?: string }): Promise<PostResult> {
    const room = typeof ref === 'string' ? this.resolve(owner, ref) : ref;
    const text = String(a.text ?? '').trim();
    if (!text) throw new Error('Nothing to post: text is empty.');
    if (ROOM_CODE_RE.test(text) || /a2a1:[A-Za-z0-9_-]{20,}/.test(text)) throw new Error('Refusing to post an invite or pairing code: it carries a secret. Give it to the person directly.');
    const kind: MessageKind = a.kind ?? 'inform';
    if (room.migrated_from) {
      const r = await this.h.pairSend(room.migrated_from, kind, text, owner);
      this.h.rooms.recordMessage({ owner: room.session_id, roomId: room.room_id, senderFp: this.identity(INSTALL_OWNER).fingerprint, msgId: `pair.${r.taskId}`, type: 'msg', kind, text, outgoing: true, taskId: r.taskId, ts: this.h.now() });
      return { room, msgId: r.taskId, delivered: 1, queued: 0, dropped: [], taskId: r.taskId, line: r.line };
    }
    if (room.status !== 'active') throw new Error(`"${room.display_name}" is not active yet (waiting for the inviter to admit this session).`);
    const body: RoomBody = { type: 'msg', kind, text, ...(a.taskId ? { taskId: a.taskId } : {}) } as RoomBody;
    const r = await this.send(owner, room, body, room.epoch);
    const me = this.identity(owner);
    this.h.rooms.recordMessage({ owner, roomId: room.room_id, senderFp: me.fingerprint, msgId: r.msgId, type: 'msg', kind, text, outgoing: true, taskId: a.taskId ?? null, ts: this.h.now() });
    this.h.audit.write({ event: 'room.posted', sessionId: owner, room: room.room_id.slice(0, 6), kind, delivered: r.delivered, queued: r.queued, dropped: r.dropped.length, text });
    return { room, ...r, taskId: a.taskId };
  }

  /** Answer a member's request (IN task) in the room: the requester's OUT task moves. */
  async postReply(owner: string, roomId: string, requesterTaskId: string, state: string | null, text: string): Promise<void> {
    const room = this.h.rooms.getRoom(owner, roomId);
    if (!room || room.status !== 'active') return;
    const r = await this.send(owner, room, { type: 'reply', taskId: requesterTaskId, state, text }, room.epoch);
    this.h.rooms.recordMessage({ owner, roomId, senderFp: this.identity(owner).fingerprint, msgId: r.msgId, type: 'reply', kind: null, text, outgoing: true, taskId: requesterTaskId, ts: this.h.now() });
  }

  // ---- inbound ---------------------------------------------------------------------

  private reject(owner: string, env: RoomEnvelope, reason: string): void {
    this.h.audit.write({ event: 'room.rejected', sessionId: owner, room: env.room.slice(0, 6), from: short(env.from), msgId: env.msgId.slice(0, 16), reason });
    this.h.log?.warn(`[a2a] dropped a room post from ${short(env.from)}: ${reason}`);
  }

  /** Every room post lands here. Whatever happens, it is acknowledged. */
  async onEnvelope(owner: string, env: RoomEnvelope): Promise<void> {
    try {
      await this.handleEnvelope(owner, env);
    } catch (e) {
      this.reject(owner, env, `handler error: ${(e as Error).message}`);
    } finally {
      await this.clients
        .get(owner)
        ?.ackRoom(env.room, env.from, env.msgId)
        .catch((e) => this.h.log?.warn(`[a2a] room ack failed: ${(e as Error).message}`));
    }
  }

  private async handleEnvelope(owner: string, env: RoomEnvelope): Promise<void> {
    const room = this.h.rooms.getRoom(owner, env.room);
    if (!room || room.status === 'left') return;
    const epoch = epochOfMsgId(env.msgId);
    if (epoch === null) return this.reject(owner, env, 'not a room message id');
    const key = this.h.rooms.getKey(owner, room.room_id, epoch);
    if (!key) return this.reject(owner, env, `no key for epoch ${epoch} (we are at ${room.epoch})`);
    let opened: { body: SignedBody; sig: string };
    try {
      opened = openRoomMessage(key, env);
    } catch {
      return this.reject(owner, env, 'failed authentication (wrong key or tampered)');
    }
    const body = opened.body;
    if (body.room !== env.room || body.msgId !== env.msgId || body.from !== env.from) return this.reject(owner, env, 'sealed fields do not match the envelope');
    const me = this.identity(owner);

    if (body.type === 'join') {
      // From someone not on the roster yet: only the member who issued the code acts on it.
      if (body.to !== me.fingerprint || room.status !== 'active') return;
      return this.onJoin(owner, room, env, body as Extract<SignedBody, { type: 'join' }>, opened.sig);
    }
    const sender = this.h.rooms.getMember(owner, room.room_id, env.from);
    if (!sender || sender.left_ts != null) return this.reject(owner, env, 'sender is not on the roster');
    if (!verifyBody(body, opened.sig, sender.public_key)) return this.reject(owner, env, 'bad signature');
    // Not admitted yet: only our own admit / deny matters; room chatter before that is not ours to read.
    if (room.status === 'pending' && !((body.type === 'admit' && body.member?.fp === me.fingerprint) || (body.type === 'deny' && body.fp === me.fingerprint))) return;
    if (!this.h.rooms.recordMessage({ owner, roomId: room.room_id, senderFp: env.from, msgId: env.msgId, type: body.type, kind: body.type === 'msg' ? body.kind : null, text: body.type === 'msg' || body.type === 'reply' ? String(body.text ?? '').slice(0, 64_000) : null, ts: this.h.now() })) {
      return; // a relay redelivery we already handled
    }
    if (room.status === 'pending') {
      if (body.type === 'admit' && body.member?.fp === me.fingerprint) return this.onAdmitted(owner, room, sender, body);
      if (body.type === 'deny' && body.fp === me.fingerprint) return this.onDenied(owner, room, body.reason);
      return;
    }
    switch (body.type) {
      case 'msg':
        return this.onMessage(owner, room, sender, env.msgId, body);
      case 'reply':
        this.h.applyReply({ owner, room, taskId: String(body.taskId), state: body.state ?? null, text: String(body.text ?? ''), who: memberLabel(sender), msgId: env.msgId });
        return;
      case 'admit':
        this.upsert(owner, room.room_id, body.member);
        this.takeBox(owner, room, sender, body.boxes, body.epoch);
        this.h.audit.write({ event: 'room.member_added', sessionId: owner, room: room.room_id.slice(0, 6), member: short(body.member.fp), by: short(sender.fingerprint) });
        this.h.changed();
        return;
      case 'rekey':
        for (const fp of body.removed ?? []) this.h.rooms.markLeft(owner, room.room_id, fp, this.h.now());
        if ((body.removed ?? []).includes(me.fingerprint)) {
          // We were removed: we never get the new key. Forget the room.
          this.h.audit.write({ event: 'room.member_removed', sessionId: owner, room: room.room_id.slice(0, 6), member: 'self', by: short(sender.fingerprint) });
          await this.clients.get(owner)?.leaveRoom(room.room_id).catch(() => {});
          this.h.rooms.deleteRoom(owner, room.room_id);
        } else {
          this.takeBox(owner, room, sender, body.boxes, body.epoch);
          for (const fp of body.removed ?? []) this.h.audit.write({ event: 'room.member_removed', sessionId: owner, room: room.room_id.slice(0, 6), member: short(fp), by: short(sender.fingerprint) });
        }
        this.h.changed();
        return;
      case 'leave':
        this.h.rooms.markLeft(owner, room.room_id, sender.fingerprint, this.h.now());
        this.h.audit.write({ event: 'room.member_removed', sessionId: owner, room: room.room_id.slice(0, 6), member: short(sender.fingerprint), by: 'left' });
        this.h.changed();
        return;
      default:
        return;
    }
  }

  private takeBox(owner: string, room: RoomRow, sender: MemberRow, boxes: Record<string, unknown> | undefined, epoch: number): void {
    const me = this.identity(owner);
    const box = boxes?.[me.fingerprint] as Parameters<typeof openBox>[3] | undefined;
    if (!box) return;
    try {
      const got = openBox(me.keyPem, me.fingerprint, { fp: sender.fingerprint, pk: sender.public_key }, box);
      if (got.epoch !== epoch) throw new Error('epoch mismatch');
      const cur = this.h.rooms.getRoom(owner, room.room_id)!;
      if (got.epoch <= cur.epoch) return; // already have it (or an older one)
      this.h.rooms.setKey(owner, room.room_id, got.epoch, got.key);
      this.h.rooms.setEpoch(owner, room.room_id, got.epoch);
    } catch (e) {
      this.h.log?.warn(`[a2a] could not open a room key box: ${(e as Error).message}`);
    }
  }

  private async onJoin(owner: string, room: RoomRow, env: RoomEnvelope, body: Extract<SignedBody, { type: 'join' }>, sig: string): Promise<void> {
    const m = body.member;
    // The joiner proves the key: signature by the key in its own entry, that
    // entry's fingerprint is the relay-proven sender, and the certificate
    // carries that key and hashes to that fingerprint.
    if (!m || m.fp !== env.from || !verifyBody(body, sig, m.pk) || !certMatches(String(body.certPem ?? ''), m.pk, m.fp)) {
      this.h.audit.write({ event: 'room.join_rejected', sessionId: owner, room: room.room_id.slice(0, 6), from: short(env.from), reason: 'identity check failed' });
      return;
    }
    if (this.h.rooms.hasMessage(owner, room.room_id, env.from, env.msgId)) return;
    this.h.rooms.recordMessage({ owner, roomId: room.room_id, senderFp: env.from, msgId: env.msgId, type: 'join', ts: this.h.now() });
    const check = this.h.rooms.consumeInvite(owner, room.room_id, body.inviteId, body.inviteSecret, this.h.now());
    if (check !== 'ok') {
      const reason = check === 'expired' ? 'the invite expired' : check === 'used' ? 'the invite was already used' : 'the invite is not valid';
      this.h.audit.write({ event: 'room.join_rejected', sessionId: owner, room: room.room_id.slice(0, 6), from: short(env.from), reason: check });
      await this.send(owner, room, { type: 'deny', fp: m.fp, reason }, epochOfMsgId(env.msgId) ?? room.epoch).catch(() => {});
      return;
    }
    this.upsert(owner, room.room_id, m);
    await this.rotate(owner, room, { type: 'admit', member: m });
    this.h.audit.write({ event: 'room.join_accepted', sessionId: owner, room: room.room_id.slice(0, 6), member: short(m.fp), name: m.name, label: m.label });
    this.h.changed();
  }

  private onAdmitted(owner: string, room: RoomRow, sender: MemberRow, body: Extract<SignedBody, { type: 'admit' }>): void {
    const keep = new Set(body.roster.map((e) => e.fp));
    for (const e of body.roster) this.upsert(owner, room.room_id, e);
    for (const m of this.h.rooms.listMembers(owner, room.room_id)) if (!keep.has(m.fingerprint)) this.h.rooms.markLeft(owner, room.room_id, m.fingerprint, this.h.now());
    this.takeBox(owner, room, sender, body.boxes, body.epoch);
    this.h.rooms.setRoomStatus(owner, room.room_id, 'active', this.h.now());
    this.h.audit.write({ event: 'room.joined', sessionId: owner, room: room.room_id.slice(0, 6), status: 'admitted', members: keep.size });
    this.pendingJoins.get(`${owner}|${room.room_id}`)?.resolve();
    this.pendingJoins.delete(`${owner}|${room.room_id}`);
    this.h.changed();
  }

  private async onDenied(owner: string, room: RoomRow, reason: string): Promise<void> {
    await this.clients.get(owner)?.leaveRoom(room.room_id).catch(() => {});
    this.h.rooms.deleteRoom(owner, room.room_id);
    this.h.audit.write({ event: 'room.join_rejected', sessionId: owner, room: room.room_id.slice(0, 6), reason: String(reason).slice(0, 100) });
    this.pendingJoins.get(`${owner}|${room.room_id}`)?.reject(new Error(`The room refused this invite: ${String(reason).slice(0, 100)}. Ask for a fresh one.`));
    this.pendingJoins.delete(`${owner}|${room.room_id}`);
    this.h.changed();
  }

  /** A verified message from a member: task for a request, then into the member session. */
  private onMessage(owner: string, room: RoomRow, sender: MemberRow, msgId: string, body: Extract<SignedBody, { type: 'msg' }>): void {
    const kind: MessageKind = body.kind === 'request' || body.kind === 'notify' ? body.kind : 'inform';
    const text = String(body.text ?? '').slice(0, 64_000);
    let taskId: string | null = null;
    if (kind !== 'inform') {
      taskId = this.h.createInTask({ owner, room, kind, text, senderFp: sender.fingerprint, requesterTaskId: typeof body.taskId === 'string' ? body.taskId : null });
      this.h.rooms.setMessageTask(owner, room.room_id, sender.fingerprint, msgId, taskId);
    }
    this.h.audit.write({ event: 'room.message', sessionId: owner, room: room.room_id.slice(0, 6), from: short(sender.fingerprint), kind, taskId, text });
    const envelope = this.envelope(room, sender, kind, text, taskId);
    this.deliver(owner, room, envelope);
    this.h.changed();
  }

  envelope(room: RoomRow, sender: Pick<MemberRow, 'display_name' | 'session_label' | 'fingerprint' | 'agent_kind'>, kind: MessageKind, text: string, taskId: string | null): string {
    return buildEnvelope({
      peerId: memberHandle(sender),
      displayName: sender.display_name || `member ${short(sender.fingerprint)}`,
      agentKind: (sender.agent_kind as AgentKind) ?? 'other',
      trust: (room.trust as TrustLevel) || 'inform',
      kind,
      taskId,
      fromSessionLabel: sender.session_label,
      room: room.display_name,
      text,
      dialect: this.h.dialect,
    });
  }

  /** Resume note for a wait-for-anything (11c): who, which room, what. */
  waitNote(room: RoomRow, envelope: string): string {
    return `[WaitForA2A] new message in room "${room.display_name}".\n${envelope}`;
  }

  /**
   * Hand a message to the member session. A session sleeping in a
   * wait-for-anything is resumed with it; otherwise the usual rules (design
   * 6.3 step 5): interrupt a running turn, start a turn when idle, queue
   * behind any other wait.
   */
  private deliver(owner: string, room: RoomRow, envelope: string): void {
    const woke = this.h.waiters.onRoomMessage({ owner, roomId: room.room_id, note: this.waitNote(room, envelope) });
    for (const s of woke.sessions) this.h.audit.write({ event: 'wait.woke', sessionId: s, room: room.room_id.slice(0, 6), kind: 'room' });
    if (woke.sessions.includes(owner) || woke.inProcess > 0) return;
    const s = this.h.sessions.listSessions().find((r) => r.id === owner && r.archived === 0);
    if (!s) return; // the session is gone; the message stays readable with A2ARead
    const mode = deliveryMode(s, this.h.sessions.isRunning(s.id));
    if (mode === 'turn' || mode === 'wake') this.h.sessions.startTurn(s, envelope);
    else {
      this.h.sessions.queueInterrupt(s.id, envelope);
      if (mode === 'queued') this.h.sessions.notify?.(`Room message in "${room.display_name}"`, `Queued for "${(s.user_title || s.title || 'a session').trim()}" until its current wait ends.`);
    }
  }

  // ---- migrated pair rooms (11b Migration) ---------------------------------------------

  /**
   * Each paired peer with a stored certificate becomes a two-member room owned
   * by the install identity. Its transport stays the pairing link (see the
   * file comment). Peers paired before v17 have no certificate and are left
   * as they are, reported with the existing re-pair wording.
   */
  migratePeers(peers: PeerRow[]): { migrated: number; skipped: Array<{ peer: string; reason: string }> } {
    const inst = this.h.installIdentity();
    const skipped: Array<{ peer: string; reason: string }> = [];
    let migrated = 0;
    const live = new Set<string>();
    for (const p of peers) {
      const avail = relayAvailableForPeer(p);
      if (!avail.ok || !inst || !p.cert_pem) {
        skipped.push({ peer: p.peer_id, reason: avail.ok ? 'no local identity' : avail.reason });
        continue;
      }
      const roomId = pairRoomId(inst.fingerprint, p.cert_sha256);
      live.add(roomId);
      if (this.h.rooms.getRoom(INSTALL_OWNER, roomId)) continue;
      this.h.rooms.insertRoom({ owner: INSTALL_OWNER, roomId, name: p.display_name || p.peer_id, relayUrl: null, status: 'active', epoch: 0, trust: p.trust, migratedFrom: p.peer_id, now: this.h.now() });
      this.upsert(INSTALL_OWNER, roomId, { fp: inst.fingerprint, pk: relayPublicKeyOf(inst.certPem), name: this.h.displayName, kind: this.h.agentKind, install: inst.fingerprint });
      this.upsert(INSTALL_OWNER, roomId, { fp: p.cert_sha256, pk: relayPublicKeyOf(p.cert_pem), name: p.display_name, kind: p.agent_kind, install: p.cert_sha256 });
      this.h.audit.write({ event: 'room.migrated', peer: p.peer_id, room: roomId.slice(0, 10) });
      migrated++;
    }
    // A peer that was unpaired takes its room with it.
    for (const r of this.h.rooms.listRooms(INSTALL_OWNER, true)) if (r.migrated_from && !live.has(r.room_id)) this.h.rooms.deleteRoom(INSTALL_OWNER, r.room_id);
    return { migrated, skipped };
  }

  /** A pairwise message arrived: keep it in the migrated room's history (A2ARead). */
  notePairInbound(peer: PeerRow, kind: string, text: string, taskId: string, messageId: string): void {
    try {
      const inst = this.h.installIdentity();
      if (!inst) return;
      const room = this.h.rooms.listRooms(INSTALL_OWNER).find((r) => r.migrated_from === peer.peer_id);
      if (!room) return;
      this.h.rooms.recordMessage({ owner: INSTALL_OWNER, roomId: room.room_id, senderFp: peer.cert_sha256, msgId: `pair.${messageId}`, type: 'msg', kind, text: text.slice(0, 64_000), taskId, ts: this.h.now() });
    } catch {
      /* history only; never break inbound delivery (and no rooms tables in the plugin daemon) */
    }
  }

  // ---- reading -------------------------------------------------------------------------

  /** Rooms this session can see, with members and who each one is. */
  list(owner?: string): RoomView[] {
    const inst = this.h.installIdentity()?.fingerprint ?? null;
    const rooms = owner === undefined ? this.h.rooms.listRooms() : [...this.h.rooms.listRooms(owner), ...(owner === INSTALL_OWNER ? [] : this.h.rooms.listRooms(INSTALL_OWNER))];
    return rooms.map((room) => {
      const mine = room.session_id === INSTALL_OWNER ? inst : this.h.rooms.getIdentity(room.session_id)?.fingerprint ?? null;
      return {
        owner: room.session_id,
        room,
        members: this.h.rooms.listMembers(room.session_id, room.room_id).map((m) => ({
          ...m,
          you: m.fingerprint === mine,
          localSession: this.h.rooms.sessionForFingerprint(m.fingerprint),
          sameInstall: !!inst && m.install_fp === inst,
        })),
      };
    });
  }

  /** Recent messages (oldest first) in one room or all of this session's rooms. */
  read(owner: string, ref: string | null, limit = 20): Array<{ room: RoomRow; row: RoomMessageRow; who: string }> {
    const rooms = ref ? [this.resolve(owner, ref)] : this.list(owner).map((v) => v.room);
    const out: Array<{ room: RoomRow; row: RoomMessageRow; who: string }> = [];
    for (const room of rooms) {
      for (const row of this.h.rooms.listMessages([room.session_id], room.room_id, limit)) {
        const m = this.h.rooms.getMember(room.session_id, room.room_id, row.sender_fp);
        out.push({ room, row, who: row.outgoing ? 'you' : m ? memberLabel(m) : `unknown ${short(row.sender_fp)}` });
      }
    }
    return out.sort((a, b) => (a.row.ts ?? 0) - (b.row.ts ?? 0)).slice(-Math.max(1, limit));
  }

  /** For a wait-for-anything resumed by the timer path: the first new message, as a note. */
  pendingNote(owners: string[], afterSeq: number, roomIds: string[]): string | null {
    const rows = this.h.rooms.incomingSince(owners, afterSeq, roomIds);
    if (!rows.length) return null;
    const row = rows[0];
    const room = this.h.rooms.getRoom(row.session_id, row.room_id);
    if (!room) return null;
    const m = this.h.rooms.getMember(row.session_id, row.room_id, row.sender_fp);
    const sender = m ?? { display_name: null, session_label: null, fingerprint: row.sender_fp, agent_kind: null };
    const more = rows.length > 1 ? `\n(${rows.length - 1} more new message${rows.length > 2 ? 's' : ''}; use A2ARead to see them.)` : '';
    return this.waitNote(room, this.envelope(room, sender, (row.kind as MessageKind) || 'inform', row.text ?? '', row.task_id)) + more;
  }
}
