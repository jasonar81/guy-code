// @vitest-environment node
/**
 * Relay end-to-end crypto (design 11a). The relay is untrusted: these tests
 * pin that it sees only ciphertext, that both peers derive the same key from
 * what pairing already exchanged, and that a third party cannot read or
 * tamper. Plus the cert_pem storage the key derivation needs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import {
  deriveRelayKey,
  openEnvelope,
  relayAvailableForPeer,
  relayNoteForPeer,
  RelayCryptoError,
  sealEnvelope,
  type RelayPayload,
  type SealedEnvelope,
} from '../../electron/a2a/relayCrypto';
import { A2A_SCHEMA_SQL, applyA2AP2Schema, applyA2AP3Schema, applyA2ARelaySchema } from '../../electron/a2a/schema';
import { A2AStore } from '../../electron/a2a/store';
import { cert, makeNode, makeSql, memSecrets, pair, type TestNode } from './helpers';

const alice = cert(0);
const bob = cert(1);
const mallory = cert(2);

const TOKEN = 'super-secret-peer-token-0123456789abcdef';
const TEXT = 'the retry policy changed in S3ChunkStream';
const request: RelayPayload = {
  method: 'POST',
  path: '/message:send',
  headers: { Authorization: `Bearer ${TOKEN}`, 'A2A-Version': '1.0' },
  body: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: TEXT }] } },
};

const keyAB = () => deriveRelayKey(alice.keyPem, bob.certPem, alice.fingerprint, bob.fingerprint);
const keyBA = () => deriveRelayKey(bob.keyPem, alice.certPem, bob.fingerprint, alice.fingerprint);

function flipFirstByte(b64: string): string {
  const b = Buffer.from(b64, 'base64');
  b[0] ^= 0x01;
  return b.toString('base64');
}

describe('relay key derivation', () => {
  it('both sides derive identical 32-byte keys from their own private key and the other side\'s cert', () => {
    const a = keyAB();
    const b = keyBA();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });

  it('is independent of fingerprint argument order', () => {
    const swapped = deriveRelayKey(alice.keyPem, bob.certPem, bob.fingerprint, alice.fingerprint);
    expect(swapped.equals(keyAB())).toBe(true);
  });

  it('is bound to the pair: a different fingerprint pair gives a different key', () => {
    const other = deriveRelayKey(alice.keyPem, bob.certPem, alice.fingerprint, mallory.fingerprint);
    expect(other.equals(keyAB())).toBe(false);
  });

  it('rejects junk input with a clear error rather than throwing something obscure', () => {
    expect(() => deriveRelayKey(alice.keyPem, 'not a cert', alice.fingerprint, bob.fingerprint)).toThrow(/peer's stored certificate could not be read/);
    expect(() => deriveRelayKey(alice.keyPem, bob.certPem, alice.fingerprint, alice.fingerprint)).toThrow(RelayCryptoError);
    expect(() => deriveRelayKey(alice.keyPem, bob.certPem, 'abc', bob.fingerprint)).toThrow(/fingerprints/);
  });
});

describe('seal / open', () => {
  it('round trips the whole request object', () => {
    const env = sealEnvelope(keyAB(), request);
    expect(openEnvelope(keyBA(), env)).toEqual(request);
  });

  it('uses a fresh IV every time', () => {
    const k = keyAB();
    expect(sealEnvelope(k, request).iv).not.toBe(sealEnvelope(k, request).iv);
  });

  it('the wire form carries neither the bearer token nor the message text', () => {
    const env = sealEnvelope(keyAB(), request);
    const wire = JSON.stringify({ to: bob.fingerprint.slice(0, 16), ...env });
    expect(Object.keys(env).sort()).toEqual(['ct', 'iv', 'tag']);
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain('Bearer');
    expect(wire).not.toContain(TEXT);
    expect(wire).not.toContain('S3ChunkStream');
    expect(wire).not.toContain('/message:send');
    // ...and not base64 of them either (the ciphertext is not just an encoding).
    expect(wire).not.toContain(Buffer.from(TOKEN).toString('base64').slice(0, 20));
  });

  it('a third party who pinned neither cert cannot decrypt: the auth tag fails', () => {
    const env = sealEnvelope(keyAB(), request);
    // Mallory knows both public certs (they are not secret) but only her own key.
    const malloryKeys = [
      deriveRelayKey(mallory.keyPem, bob.certPem, alice.fingerprint, bob.fingerprint),
      deriveRelayKey(mallory.keyPem, alice.certPem, alice.fingerprint, bob.fingerprint),
    ];
    for (const k of malloryKeys) expect(() => openEnvelope(k, env)).toThrow(/failed authentication/);
  });

  it('a payload sealed for one pair does not open under another pair\'s key (no cross-peer replay)', () => {
    const env = sealEnvelope(keyAB(), request);
    const bobMallory = deriveRelayKey(bob.keyPem, mallory.certPem, bob.fingerprint, mallory.fingerprint);
    expect(() => openEnvelope(bobMallory, env)).toThrow(RelayCryptoError);
  });

  it('tampering with ct, tag or iv fails authentication', () => {
    const k = keyAB();
    const env = sealEnvelope(k, request);
    const bad: SealedEnvelope[] = [
      { ...env, ct: flipFirstByte(env.ct) },
      { ...env, tag: flipFirstByte(env.tag) },
      { ...env, iv: flipFirstByte(env.iv) },
    ];
    for (const e of bad) expect(() => openEnvelope(k, e)).toThrow(/failed authentication/);
  });

  it('a malformed envelope or a wrong-size key fails clearly', () => {
    const k = keyAB();
    expect(() => openEnvelope(k, { iv: 'x' } as unknown as SealedEnvelope)).toThrow(/malformed/);
    expect(() => openEnvelope(k, { ...sealEnvelope(k, request), tag: 'AAAA' })).toThrow(/malformed/);
    expect(() => sealEnvelope(Buffer.alloc(16), request)).toThrow(/32 bytes/);
  });
});

describe('relay availability per peer', () => {
  const base = { peer_id: 'dylan', display_name: 'Dylan Murphy', cert_sha256: bob.fingerprint };

  it('a peer with no cert_pem (paired before relay support) is unavailable with a re-pair message, and does not throw', () => {
    for (const cert_pem of [null, undefined, '']) {
      const r = relayAvailableForPeer({ ...base, cert_pem });
      expect(r).toEqual({ ok: false, reason: 'paired before relay support; re-pair Dylan Murphy to use the relay' });
    }
    expect(relayNoteForPeer({ ...base, cert_pem: null })).toBe('Relay unavailable: paired before relay support; re-pair Dylan Murphy to use the relay.');
  });

  it('falls back to the handle when there is no display name', () => {
    const r = relayAvailableForPeer({ ...base, display_name: null, cert_pem: null });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/re-pair dylan to use the relay/);
  });

  it('a stored cert that does not match the pin, or is garbage, is unavailable rather than a crash', () => {
    expect(relayAvailableForPeer({ ...base, cert_pem: mallory.certPem })).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match/) });
    expect(relayAvailableForPeer({ ...base, cert_pem: 'garbage' })).toMatchObject({ ok: false, reason: expect.stringMatching(/unreadable/) });
  });

  it('a peer with a matching cert is available', () => {
    expect(relayAvailableForPeer({ ...base, cert_pem: bob.certPem })).toEqual({ ok: true });
    expect(relayNoteForPeer({ ...base, cert_pem: bob.certPem })).toBeNull();
  });
});

describe('cert_pem storage', () => {
  const nodes: TestNode[] = [];
  afterEach(async () => {
    for (const n of nodes.splice(0)) await n.node.stop();
  });

  it('pairing stores each side\'s cert PEM in BOTH directions, and the stored PEMs derive matching keys', async () => {
    const a = await makeNode({ name: 'Alice', certIndex: 0 });
    const b = await makeNode({ name: 'Bob', certIndex: 1 });
    nodes.push(a, b);
    const { aSeesB, bSeesA } = await pair(a, b);
    const onA = a.node.store.getPeer(aSeesB)!; // inviter's row for the redeemer
    const onB = b.node.store.getPeer(bSeesA)!; // redeemer's row for the inviter
    expect(onA.cert_pem).toBe(bob.certPem);
    expect(onB.cert_pem).toBe(alice.certPem);
    expect(relayAvailableForPeer(onA)).toEqual({ ok: true });
    expect(relayAvailableForPeer(onB)).toEqual({ ok: true });
    const kA = deriveRelayKey(alice.keyPem, onA.cert_pem!, alice.fingerprint, onA.cert_sha256);
    const kB = deriveRelayKey(bob.keyPem, onB.cert_pem!, bob.fingerprint, onB.cert_sha256);
    expect(kA.equals(kB)).toBe(true);
  });

  it('a legacy peer row (no cert_pem) loads and reports relay-unavailable', async () => {
    const { sql } = await makeSql();
    const store = new A2AStore(sql, memSecrets());
    store.savePairedPeer({
      peerId: 'old',
      displayName: 'Old Timer',
      agentKind: 'guycode',
      cardUrl: 'https://10.0.0.9:7427/.well-known/agent-card.json',
      certSha256: bob.fingerprint,
      tokenOut: 'x'.repeat(40),
      tokenIn: 'y'.repeat(40),
    });
    const row = store.getPeer('old')!;
    expect(row.cert_pem).toBeNull();
    expect(relayNoteForPeer(row)).toMatch(/paired before relay support; re-pair Old Timer to use the relay/);
  });
});

describe('v17 migration: a2a_peers.cert_pem', () => {
  it('a database at the previous version (v16 schema) gains the column, keeps its rows, and a second run is safe', async () => {
    const SQL = await initSqlJs();
    const d = new SQL.Database();
    const cols = (t: string) => {
      const r = d.exec(`PRAGMA table_info(${t})`);
      return r.length ? r[0].values.map((v) => String(v[1])) : [];
    };
    // Exactly what a v16 database has.
    d.exec(A2A_SCHEMA_SQL);
    applyA2AP2Schema((q) => d.exec(q), cols);
    applyA2AP3Schema((q) => d.exec(q), cols);
    d.run("INSERT INTO a2a_peers (peer_id, card_url, cert_sha256) VALUES ('old', 'https://x', ?)", [bob.fingerprint]);
    expect(cols('a2a_peers')).not.toContain('cert_pem');

    applyA2ARelaySchema((q) => d.exec(q), cols);
    applyA2ARelaySchema((q) => d.exec(q), cols); // must be a no-op, not "duplicate column"
    expect(cols('a2a_peers')).toContain('cert_pem');
    const r = d.exec("SELECT cert_pem FROM a2a_peers WHERE peer_id = 'old'");
    expect(r[0].values[0][0]).toBeNull();
  });

  it('db.ts runs it as migration v17 through the PRAGMA guard, not raw ALTER TABLE', () => {
    const db = readFileSync(join(__dirname, '..', '..', 'electron', 'db.ts'), 'utf8');
    expect(db).toMatch(/version: 17,[\s\S]{0,600}applyA2ARelaySchema\(/);
    expect(db).not.toMatch(/ALTER TABLE a2a_peers ADD COLUMN cert_pem/);
  });
});
