// @vitest-environment node
/**
 * The hand-rolled DER certificate builder (electron/a2a/tls.ts) and the
 * pinning it exists for. If the DER is subtly wrong, Node's X509 parser or
 * its TLS stack will refuse it, so both are exercised here for real.
 */
import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  generateSelfSignedCert,
  fingerprintOfPem,
  checkPinnedIdentity,
  connectPinned,
  normaliseFingerprint,
  CertPinMismatchError,
} from '../../electron/a2a/tls';

describe('generateSelfSignedCert', () => {
  const id = generateSelfSignedCert({ commonName: 'guycode-a2a', ips: ['127.0.0.1', '10.30.1.23', '::1'], dnsNames: ['localhost'] });

  it('produces a certificate that crypto.X509Certificate parses', () => {
    const x = new crypto.X509Certificate(id.certPem);
    expect(x.subject).toContain('CN=guycode-a2a');
    expect(x.issuer).toBe(x.subject); // self-signed
    expect(x.ca).toBe(true);
  });

  it('carries the requested SAN entries, DNS and IPv4 and IPv6', () => {
    const san = new crypto.X509Certificate(id.certPem).subjectAltName ?? '';
    expect(san).toContain('DNS:localhost');
    expect(san).toContain('IP Address:127.0.0.1');
    expect(san).toContain('IP Address:10.30.1.23');
    expect(san).toMatch(/IP Address:0?:?0?:?.*:1|IP Address:::1/);
  });

  it('is signed by its own key (signature verifies)', () => {
    const x = new crypto.X509Certificate(id.certPem);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.checkPrivateKey(crypto.createPrivateKey(id.keyPem))).toBe(true);
  });

  it('is valid now and for about ten years', () => {
    const x = new crypto.X509Certificate(id.certPem);
    const from = Date.parse(x.validFrom);
    const to = Date.parse(x.validTo);
    expect(from).toBeLessThanOrEqual(Date.now());
    expect(to - Date.now()).toBeGreaterThan(9.9 * 365 * 86400_000);
  });

  it('uses GeneralizedTime past 2049 (RFC 5280) and still parses', () => {
    const late = generateSelfSignedCert({ commonName: 'late', now: new Date('2045-06-01T00:00:00Z'), days: 3650 });
    const x = new crypto.X509Certificate(late.certPem);
    expect(new Date(x.validTo).getUTCFullYear()).toBe(2055);
  });

  it('fingerprint is sha256 of the DER, and fingerprintOfPem agrees', () => {
    const der = new crypto.X509Certificate(id.certPem).raw;
    expect(id.fingerprint).toBe(crypto.createHash('sha256').update(der).digest('hex'));
    expect(fingerprintOfPem(id.certPem)).toBe(id.fingerprint);
    expect(id.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every certificate gets a fresh key and serial', () => {
    const other = generateSelfSignedCert({ commonName: 'guycode-a2a' });
    expect(other.fingerprint).not.toBe(id.fingerprint);
    expect(new crypto.X509Certificate(other.certPem).serialNumber).not.toBe(new crypto.X509Certificate(id.certPem).serialNumber);
  });

  it('normaliseFingerprint accepts colon-separated upper case', () => {
    const colons = id.fingerprint.toUpperCase().match(/../g)!.join(':');
    expect(normaliseFingerprint(colons)).toBe(id.fingerprint);
  });
});

describe('pinning', () => {
  const a = generateSelfSignedCert({ commonName: 'a', ips: ['127.0.0.1'] });
  const b = generateSelfSignedCert({ commonName: 'b', ips: ['127.0.0.1'] });

  it('checkPinnedIdentity accepts the right cert and rejects others', () => {
    const raw = new crypto.X509Certificate(a.certPem).raw;
    expect(checkPinnedIdentity(a.fingerprint, { raw })).toBeUndefined();
    expect(checkPinnedIdentity(b.fingerprint, { raw })).toBeInstanceOf(CertPinMismatchError);
    expect(checkPinnedIdentity(a.fingerprint, undefined)).toBeInstanceOf(CertPinMismatchError);
  });

  it('Node TLS accepts the generated cert; connectPinned enforces the pin', async () => {
    const server = https.createServer({ cert: a.certPem, key: a.keyPem }, (_q, r) => r.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const good = await connectPinned({ host: '127.0.0.1', port, fingerprint: a.fingerprint });
      expect(good.authorized === false || good.authorized === true).toBe(true);
      good.destroy();
      await expect(connectPinned({ host: '127.0.0.1', port, fingerprint: b.fingerprint })).rejects.toBeInstanceOf(CertPinMismatchError);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
