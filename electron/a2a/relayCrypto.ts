/**
 * End-to-end encryption for the A2A relay (docs/a2a/DESIGN.md 11a).
 *
 * WHY: on a Fortinet-style SSL VPN two laptops can never reach each other, so
 * both dial out to a relay. That relay must be UNTRUSTED: it may sit on a
 * shared box or, later, on IT hardware, and it must never see a bearer token
 * or a message body. So the whole request (method, path, headers including
 * Authorization, and body) is sealed here and the relay forwards only
 * `{to, iv, ct, tag}`.
 *
 * No new dependency and no extra pairing step: pairing already pins each
 * side's certificate, and those certificates are EC P-256 (tls.ts). ECDH
 * between my cert key and the peer's pinned cert public key gives both sides
 * the same secret with no new key exchange. HKDF turns it into an AES-256-GCM
 * key bound to the pair (salt = the two fingerprints, sorted so both sides
 * agree), so a payload sealed for one peer cannot be replayed at another.
 *
 * Known limitation (stated, not hidden): this is NOT forward secret. A stolen
 * long-lived cert key exposes past relay traffic. The upgrade is an ephemeral
 * ECDH per session.
 */
import * as crypto from 'node:crypto';
import { fingerprintOfPem, normaliseFingerprint } from './tls';

export const RELAY_HKDF_INFO = 'a2a-relay-v1';
const KEY_BYTES = 32;
const IV_BYTES = 12; // the GCM standard nonce size
const TAG_BYTES = 16;

/** The plaintext the relay must never see: the entire request. */
export interface RelayPayload {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** What actually crosses the relay (base64 strings). */
export interface SealedEnvelope {
  iv: string;
  ct: string;
  tag: string;
}

export class RelayCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayCryptoError';
  }
}

/**
 * Derive the symmetric key for one pair of peers. Each side calls it with its
 * OWN private key and the OTHER side's pinned certificate; both get the same
 * 32 bytes. Fingerprint order does not matter.
 */
export function deriveRelayKey(myPrivateKeyPem: string, theirCertPem: string, myFingerprint: string, theirFingerprint: string): Buffer {
  const a = normaliseFingerprint(myFingerprint);
  const b = normaliseFingerprint(theirFingerprint);
  if (a.length !== 64 || b.length !== 64) throw new RelayCryptoError('Relay key derivation needs two SHA-256 certificate fingerprints.');
  if (a === b) throw new RelayCryptoError('Relay key derivation needs two different peers (both fingerprints are the same).');
  let privateKey: crypto.KeyObject;
  let publicKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(myPrivateKeyPem);
  } catch {
    throw new RelayCryptoError('Our own TLS private key could not be read.');
  }
  try {
    publicKey = new crypto.X509Certificate(theirCertPem).publicKey;
  } catch {
    throw new RelayCryptoError("The peer's stored certificate could not be read.");
  }
  if (privateKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyType !== 'ec') {
    throw new RelayCryptoError('Relay encryption needs EC (P-256) certificates on both sides.');
  }
  const shared = crypto.diffieHellman({ privateKey, publicKey });
  const salt = Buffer.from([a, b].sort().join(':'), 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', shared, salt, Buffer.from(RELAY_HKDF_INFO, 'utf8'), KEY_BYTES));
}

/** Encrypt a request object with AES-256-GCM. A fresh random IV every call. */
export function sealEnvelope(key: Buffer, payload: RelayPayload | Record<string, unknown>): SealedEnvelope {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new RelayCryptoError('Relay key must be 32 bytes.');
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

/**
 * Decrypt and authenticate. A wrong key, or any change to iv / ct / tag,
 * fails the GCM auth tag and throws RelayCryptoError; it never returns
 * garbage.
 */
export function openEnvelope<T = RelayPayload>(key: Buffer, env: SealedEnvelope): T {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new RelayCryptoError('Relay key must be 32 bytes.');
  if (!env || typeof env.iv !== 'string' || typeof env.ct !== 'string' || typeof env.tag !== 'string') {
    throw new RelayCryptoError('Relay envelope is malformed (needs iv, ct and tag).');
  }
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new RelayCryptoError('Relay envelope is malformed (bad iv or tag length).');
  let plain: string;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    d.setAuthTag(tag);
    plain = Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new RelayCryptoError('Relay envelope failed authentication (wrong key or tampered in transit).');
  }
  try {
    return JSON.parse(plain) as T;
  } catch {
    throw new RelayCryptoError('Relay envelope decrypted but is not valid JSON.');
  }
}

/** The bits of a peer row the relay check needs. */
export interface RelayPeerInfo {
  peer_id: string;
  display_name: string | null;
  cert_sha256: string;
  cert_pem?: string | null;
}

export type RelayAvailability = { ok: true } | { ok: false; reason: string };

/**
 * Can we talk to this peer through the relay? Peers paired before relay
 * support have no stored certificate, so there is no public key to derive a
 * key from. Never throws: returns a reason the user can act on.
 */
export function relayAvailableForPeer(peer: RelayPeerInfo): RelayAvailability {
  const name = peer.display_name || peer.peer_id;
  const repair = `re-pair ${name} to use the relay`;
  if (!peer.cert_pem) return { ok: false, reason: `paired before relay support; ${repair}` };
  try {
    const x = new crypto.X509Certificate(peer.cert_pem);
    if (x.publicKey.asymmetricKeyType !== 'ec') return { ok: false, reason: `stored certificate is not EC P-256; ${repair}` };
    if (fingerprintOfPem(peer.cert_pem) !== normaliseFingerprint(peer.cert_sha256)) {
      return { ok: false, reason: `stored certificate does not match the pinned fingerprint; ${repair}` };
    }
  } catch {
    return { ok: false, reason: `stored certificate is unreadable; ${repair}` };
  }
  return { ok: true };
}

/** One-line note for peer listings, or null when the relay is usable. */
export function relayNoteForPeer(peer: RelayPeerInfo): string | null {
  const r = relayAvailableForPeer(peer);
  return r.ok ? null : `Relay unavailable: ${r.reason}.`;
}
