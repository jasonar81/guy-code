/**
 * Proof of identity for relay agents (docs/a2a/DESIGN.md 11a).
 *
 * An agent's identity is the SHA-256 fingerprint of its certificate - the same
 * value peers already pin at pairing. Asserting a fingerprint is worthless
 * (fingerprints are not secret), so an agent must PROVE it holds the matching
 * private key:
 *
 *   1. The relay sends a fresh random nonce down the agent's new stream.
 *   2. The agent signs  "a2a-relay-auth-v1\n<nonce>"  with its cert private key
 *      and posts {nonce, fingerprint, certPem, signature}.
 *   3. The relay checks sha256(cert DER) == the claimed fingerprint, and that
 *      the signature verifies under the public key IN that cert.
 *
 * Someone holding only Alice's certificate (public) cannot produce the
 * signature; someone presenting their own cert cannot claim Alice's
 * fingerprint. The context prefix stops a signature made for the relay being
 * reused as anything else, and the nonce is single use and short lived.
 *
 * Only node:crypto. Nothing here is imported from electron/: the relay is a
 * standalone service.
 */
import * as crypto from 'node:crypto';

export const AUTH_CONTEXT = 'a2a-relay-auth-v1';

/** The exact bytes an agent signs for a given nonce. */
export function authMessage(nonce: string): Buffer {
  return Buffer.from(`${AUTH_CONTEXT}\n${nonce}`, 'utf8');
}

/** Lowercase hex, separators stripped ("AB:CD..." and "abcd..." are the same). */
export function normaliseFingerprint(fp: unknown): string {
  return String(fp ?? '')
    .replace(/[^0-9a-fA-F]/g, '')
    .toLowerCase();
}

export function isFingerprint(fp: unknown): fp is string {
  return typeof fp === 'string' && /^[0-9a-f]{64}$/.test(fp);
}

export function fingerprintOfCert(cert: crypto.X509Certificate): string {
  return crypto.createHash('sha256').update(cert.raw).digest('hex');
}

/** Agent side: sign a relay challenge. Exported for clients and tests. */
export function signChallenge(nonce: string, privateKeyPem: string): string {
  return crypto.sign('sha256', authMessage(nonce), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export interface ProofInput {
  nonce: string;
  claimedFingerprint: unknown;
  certPem: unknown;
  signature: unknown;
}

export type ProofResult = { ok: true; fingerprint: string } | { ok: false; reason: string };

/** Relay side. Never throws; a rejection carries a reason safe to log and return. */
export function verifyProof(input: ProofInput, now: number = Date.now()): ProofResult {
  const claimed = normaliseFingerprint(input.claimedFingerprint);
  if (!isFingerprint(claimed)) return { ok: false, reason: 'fingerprint must be a SHA-256 hex digest' };
  if (typeof input.certPem !== 'string' || !input.certPem.includes('BEGIN CERTIFICATE')) {
    return { ok: false, reason: 'certPem must be a PEM certificate' };
  }
  if (typeof input.signature !== 'string' || !input.signature) return { ok: false, reason: 'signature missing' };
  let cert: crypto.X509Certificate;
  try {
    cert = new crypto.X509Certificate(input.certPem);
  } catch {
    return { ok: false, reason: 'certificate unreadable' };
  }
  if (fingerprintOfCert(cert) !== claimed) return { ok: false, reason: 'certificate does not match the claimed fingerprint' };
  if (cert.publicKey.asymmetricKeyType !== 'ec') return { ok: false, reason: 'certificate key must be EC P-256' };
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (Number.isFinite(from) && Number.isFinite(to) && (now < from || now > to)) {
    return { ok: false, reason: 'certificate is outside its validity period' };
  }
  let good = false;
  try {
    good = crypto.verify('sha256', authMessage(input.nonce), cert.publicKey, Buffer.from(input.signature, 'base64'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'signature does not verify against the certificate key' };
  return { ok: true, fingerprint: claimed };
}
