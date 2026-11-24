/**
 * Room cryptography and invite codes (design 11b). Pure functions, no I/O.
 *
 * A room message on the wire is the relay's six fields. Inside `ct` (sealed
 * with the room key of one EPOCH, relayCrypto.sealEnvelope) is
 *   { v: 1, body, sig }
 * where `body` always names the room, the msgId and the sender fingerprint,
 * and `sig` is ECDSA-SHA256 by the SENDER'S OWN key over
 * "a2a-room-v1\n" + JSON(body).
 *
 * WHY THE SIGNATURE (the load-bearing fact of 11b): every member holds the
 * room key, so "it decrypted" proves only "a member sealed it". Without a
 * signature any member can write `from: alice` and AES-GCM accepts it. A
 * receiver therefore checks, in order: the body names this room, this msgId
 * and the relay-proven sender; the sender is on the roster (not left); the
 * signature verifies against the roster's public key for that sender.
 * Anything else is dropped and audited, never shown to a model.
 *
 * The epoch is in the msgId ("e<epoch>.<hex>") because the relay accepts no
 * extra field and the receiver must know which key to try. Removing a member
 * bumps the epoch with a fresh random key; the new key travels in per-member
 * BOXES sealed with a key derived pairwise (ECDH of the two members' own keys),
 * so the removed member - who still holds the old room key - cannot open it.
 * Admitting a member rotates too: the key printed in an invite code is then
 * only good until the code is used, so a code seen later (Slack history)
 * reads nothing sent after the join.
 */
import * as crypto from 'node:crypto';
import { RelayCryptoError, deriveRelayKeyFromPublicKey, openEnvelope, publicKeyFromRelayKey, sealEnvelope, type SealedEnvelope } from './relayCrypto';
import { fingerprintOfPem, normaliseFingerprint } from './tls';

export const ROOM_SIG_CONTEXT = 'a2a-room-v1';
export const ROOM_CODE_PREFIX = 'a2r1:';
/** A room invite code anywhere in a text (they carry the room key: never post one). */
export const ROOM_CODE_RE = /a2r1:[A-Za-z0-9_-]{20,}/;
/** Same id rule as the relay (relay/src/server.ts ROOM_ID_RE). */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MSG_ID_RE = /^e(\d{1,9})\.[0-9a-f]{8,64}$/;

/** One roster entry as it travels in codes and admit messages. */
export interface RosterEntry {
  fp: string;
  /** SPKI DER base64url (relayCrypto.relayPublicKeyOf). */
  pk: string;
  name?: string | null;
  label?: string | null;
  kind?: string | null;
  install?: string | null;
}

export type RoomBody =
  | { type: 'msg'; kind: 'inform' | 'request' | 'notify'; text: string; taskId?: string; project?: string }
  | { type: 'reply'; taskId: string; state: string | null; text: string }
  /** `to` = the member who issued the code; only it acts on the join. */
  | { type: 'join'; to: string; inviteId: string; inviteSecret: string; member: RosterEntry; certPem: string }
  | { type: 'admit'; member: RosterEntry; roster: RosterEntry[]; epoch: number; boxes: Record<string, SealedEnvelope> }
  | { type: 'deny'; fp: string; reason: string }
  | { type: 'leave' }
  | { type: 'rekey'; epoch: number; removed: string[]; boxes: Record<string, SealedEnvelope> };

/** What is signed and sealed: the body plus the binding fields. */
export type SignedBody = RoomBody & { room: string; msgId: string; from: string; ts: number };

export function newRoomId(): string {
  return 'r' + crypto.randomBytes(18).toString('base64url');
}

export function newRoomKey(): Buffer {
  return crypto.randomBytes(32);
}

export function newMsgId(epoch: number): string {
  return `e${epoch}.${crypto.randomBytes(12).toString('hex')}`;
}

/** The epoch a msgId was sealed under, or null for a msgId that is not ours. */
export function epochOfMsgId(msgId: string): number | null {
  const m = MSG_ID_RE.exec(msgId);
  return m ? Number(m[1]) : null;
}

function signedBytes(body: SignedBody): Buffer {
  return Buffer.from(`${ROOM_SIG_CONTEXT}\n${JSON.stringify(body)}`, 'utf8');
}

export function signBody(body: SignedBody, keyPem: string): string {
  return crypto.sign('sha256', signedBytes(body), crypto.createPrivateKey(keyPem)).toString('base64');
}

export function verifyBody(body: SignedBody, sig: string, pk: string): boolean {
  try {
    return crypto.verify('sha256', signedBytes(body), publicKeyFromRelayKey(pk), Buffer.from(String(sig ?? ''), 'base64'));
  } catch {
    return false;
  }
}

/** Seal a signed body with the room key of one epoch. */
export function sealRoomMessage(key: Buffer, body: SignedBody, keyPem: string): SealedEnvelope {
  return sealEnvelope(key, { v: 1, body, sig: signBody(body, keyPem) });
}

/** Decrypt only. Signature and binding checks are the caller's (they need the roster). */
export function openRoomMessage(key: Buffer, env: SealedEnvelope): { body: SignedBody; sig: string } {
  const o = openEnvelope<{ v?: unknown; body?: unknown; sig?: unknown }>(key, env);
  if (!o || o.v !== 1 || !o.body || typeof o.body !== 'object' || typeof o.sig !== 'string') throw new RelayCryptoError('Room message is malformed.');
  return { body: o.body as SignedBody, sig: o.sig };
}

/** Key for a per-member box: ECDH of the two members' own keys, then a room-specific HKDF. */
export function boxKey(myKeyPem: string, theirPk: string, myFp: string, theirFp: string): Buffer {
  const pair = deriveRelayKeyFromPublicKey(myKeyPem, publicKeyFromRelayKey(theirPk), myFp, theirFp);
  return Buffer.from(crypto.hkdfSync('sha256', pair, Buffer.alloc(0), Buffer.from('a2a-room-box-v1', 'utf8'), 32));
}

export function sealBox(myKeyPem: string, myFp: string, to: RosterEntry, payload: { key: string; epoch: number }): SealedEnvelope {
  return sealEnvelope(boxKey(myKeyPem, to.pk, myFp, to.fp), payload);
}

export function openBox(myKeyPem: string, myFp: string, from: { fp: string; pk: string }, box: SealedEnvelope): { key: Buffer; epoch: number } {
  const p = openEnvelope<{ key?: unknown; epoch?: unknown }>(boxKey(myKeyPem, from.pk, myFp, from.fp), box);
  const key = Buffer.from(String(p?.key ?? ''), 'base64');
  if (key.length !== 32 || typeof p.epoch !== 'number') throw new RelayCryptoError('Room key box is malformed.');
  return { key, epoch: p.epoch };
}

/** Does this certificate carry this public key, and hash to this fingerprint? */
export function certMatches(certPem: string, pk: string, fp: string): boolean {
  try {
    if (fingerprintOfPem(certPem) !== normaliseFingerprint(fp)) return false;
    const a = new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const b = Buffer.from(pk, 'base64url');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---- invite codes ---------------------------------------------------------------

export interface RoomCodePayload {
  v: 1;
  room: string;
  name: string;
  relay: string;
  /** Room key, base64url, and the epoch it belongs to. */
  key: string;
  epoch: number;
  inviteId: string;
  secret: string;
  expires: number;
  /** The member who issued it (and will admit the joiner). */
  by: string;
  roster: RosterEntry[];
}

export function encodeRoomCode(p: RoomCodePayload): string {
  return ROOM_CODE_PREFIX + Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

/** Decode and shape-check. Throws plain-English errors. */
export function decodeRoomCode(code: string): RoomCodePayload {
  const s = String(code ?? '').replace(/[\s`'"]/g, '');
  if (!s.startsWith(ROOM_CODE_PREFIX)) throw new Error('That is not an A2A room invite (it should start with "a2r1:").');
  let p: RoomCodePayload;
  try {
    p = JSON.parse(Buffer.from(s.slice(ROOM_CODE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('The room invite is damaged (could not decode it). Ask for a fresh one.');
  }
  const ok =
    p &&
    p.v === 1 &&
    typeof p.room === 'string' &&
    ROOM_ID_RE.test(p.room) &&
    typeof p.relay === 'string' &&
    typeof p.key === 'string' &&
    Buffer.from(p.key, 'base64url').length === 32 &&
    Number.isInteger(p.epoch) &&
    typeof p.inviteId === 'string' &&
    typeof p.secret === 'string' &&
    typeof p.expires === 'number' &&
    typeof p.by === 'string' &&
    Array.isArray(p.roster) &&
    p.roster.length > 0 &&
    p.roster.length <= 50 &&
    p.roster.every((m) => m && typeof m.fp === 'string' && /^[0-9a-f]{64}$/.test(m.fp) && typeof m.pk === 'string') &&
    p.roster.some((m) => m.fp === p.by);
  if (!ok) throw new Error('The room invite is incomplete. Ask for a fresh one.');
  return { ...p, name: String(p.name ?? '').slice(0, 80) };
}
