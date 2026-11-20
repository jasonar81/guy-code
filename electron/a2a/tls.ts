/**
 * Self-signed TLS identity for the A2A endpoint, with no new dependency.
 *
 * Why hand-rolled: Node can generate key pairs (`generateKeyPairSync`) and
 * parse certificates (`X509Certificate`) but has no certificate builder, and
 * the `selfsigned` package drags in `@peculiar/x509` + `pkijs`. A self-signed
 * certificate is a small fixed DER structure, so we write it here (design
 * 12a, "TLS certs").
 *
 * Trust model: peers never validate us against a CA or a hostname. The
 * pairing code carries the SHA-256 of our certificate's DER, and the client
 * pins that exact fingerprint (see `connectPinned`). So the SAN entries are
 * there to keep generic TLS tooling happy, not for security, and a change of
 * IP address does not need a new certificate. Regenerating the certificate
 * DOES change the fingerprint and forces every peer to re-pair, which is the
 * intended behaviour for a key change.
 */
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';

// ---- minimal DER writers ----------------------------------------------------

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

const der = {
  seq: (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts)),
  set: (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts)),
  /** Unsigned big-endian INTEGER. A leading 0x00 keeps it positive when the top bit is set. */
  int: (v: Buffer | number) => {
    let b = Buffer.isBuffer(v) ? v : Buffer.from([v]);
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return tlv(0x02, b);
  },
  oid: (dotted: string) => {
    const p = dotted.split('.').map(Number);
    const out = [p[0] * 40 + p[1]];
    for (const v of p.slice(2)) {
      const chunk: number[] = [];
      let x = v;
      do {
        chunk.unshift(x & 0x7f);
        x >>= 7;
      } while (x > 0);
      for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
      out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
  },
  utf8: (s: string) => tlv(0x0c, Buffer.from(s, 'utf8')),
  bitString: (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b])),
  octet: (b: Buffer) => tlv(0x04, b),
  bool: (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00])),
  /**
   * RFC 5280 says UTCTime for years up to 2049 and GeneralizedTime from 2050.
   * A 10-year cert minted after 2039 would cross that line, so pick per date.
   */
  time: (d: Date) => {
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    const rest =
      p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
    const y = d.getUTCFullYear();
    if (y < 2050) return tlv(0x17, Buffer.from(p(y % 100) + rest, 'ascii'));
    return tlv(0x18, Buffer.from(p(y, 4) + rest, 'ascii'));
  },
  /** Context-specific tag [n], constructed (EXPLICIT) by default. */
  ctx: (n: number, body: Buffer, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body),
};

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_CN = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';

/** IPv4 dotted quad or any IPv6 form -> the 4 or 16 raw bytes an iPAddress SAN wants. */
function ipBytes(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) throw new Error(`not an IP address: ${ip}`);
  // Expand "::" and an optional trailing dotted IPv4 into 8 hex groups.
  let s = ip;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const b = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  const groups = [...h, ...fill, ...t];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

export interface SelfSignedOptions {
  commonName: string;
  ips?: string[];
  dnsNames?: string[];
  days?: number;
  /** Override "now", for tests of validity windows. */
  now?: Date;
}

export interface TlsIdentity {
  certPem: string;
  keyPem: string;
  /** Lowercase hex SHA-256 of the certificate DER. This is what peers pin. */
  fingerprint: string;
}

function toPem(tag: string, b: Buffer): string {
  const body = b.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${tag}-----\n${body}\n-----END ${tag}-----\n`;
}

/**
 * Build an ECDSA P-256 self-signed X.509 v3 certificate.
 *
 * P-256 rather than RSA: key generation is instant (RSA-2048 can take a
 * noticeable fraction of a second on the main process) and every TLS stack we
 * care about accepts it.
 */
export function generateSelfSignedCert(opts: SelfSignedOptions): TlsIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const sigAlg = der.seq(der.oid(OID_ECDSA_SHA256));
  const name = der.seq(der.set(der.seq(der.oid(OID_CN), der.utf8(opts.commonName))));
  const now = opts.now ?? new Date();
  const days = opts.days ?? 3650;
  // Backdate a minute so a peer whose clock is slightly behind does not see a
  // "not yet valid" cert straight after we mint it.
  const validity = der.seq(der.time(new Date(now.getTime() - 60_000)), der.time(new Date(now.getTime() + days * 86_400_000)));
  const sanParts = [
    ...(opts.dnsNames ?? []).map((d) => tlv(0x82, Buffer.from(d, 'ascii'))), // dNSName [2]
    ...(opts.ips ?? []).map((ip) => tlv(0x87, ipBytes(ip))), // iPAddress [7]
  ];
  const extList: Buffer[] = [
    // basicConstraints, critical, CA:TRUE. A self-signed leaf has to be its own
    // issuer; OpenSSL refuses to build a chain otherwise.
    der.seq(der.oid(OID_BASIC_CONSTRAINTS), der.bool(true), der.octet(der.seq(der.bool(true)))),
  ];
  if (sanParts.length) extList.push(der.seq(der.oid(OID_SUBJECT_ALT_NAME), der.octet(der.seq(...sanParts))));
  // Serial: 8 random bytes with the top bit cleared so it is positive without
  // padding, and never zero.
  const serial = crypto.randomBytes(8);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const tbs = der.seq(
    der.ctx(0, der.int(2)), // version v3
    der.int(serial),
    sigAlg,
    name, // issuer
    validity,
    name, // subject (self-signed)
    spki,
    der.ctx(3, der.seq(...extList))
  );
  const sig = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const cert = der.seq(tbs, sigAlg, der.bitString(sig));
  return {
    certPem: toPem('CERTIFICATE', cert),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    fingerprint: fingerprintOfDer(cert),
  };
}

export function fingerprintOfDer(raw: Buffer): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Fingerprint of a PEM certificate, in the same form `generateSelfSignedCert` returns. */
export function fingerprintOfPem(pem: string): string {
  return fingerprintOfDer(new crypto.X509Certificate(pem).raw);
}

/** Normalise user / wire input: accept "AB:CD:..." or plain hex, any case. */
export function normaliseFingerprint(fp: string): string {
  return String(fp || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

export class CertPinMismatchError extends Error {
  readonly code = 'A2A_CERT_PIN_MISMATCH';
  constructor(readonly expected: string, readonly actual: string) {
    super(
      `TLS certificate for this peer changed (expected sha256 ${expected.slice(0, 16)}..., got ${actual.slice(0, 16)}...). ` +
        'This is never auto-accepted: re-pair with a fresh pairing code if the peer really regenerated its key.'
    );
    this.name = 'CertPinMismatchError';
  }
}

/**
 * The pin check, in `checkServerIdentity` form: return undefined to accept,
 * an Error to reject. Compares the certificate DER's SHA-256 in constant time.
 */
export function checkPinnedIdentity(expectedFingerprint: string, cert: { raw?: Buffer } | undefined): Error | undefined {
  const want = normaliseFingerprint(expectedFingerprint);
  if (!cert?.raw || !want) return new CertPinMismatchError(want, '(no certificate)');
  const got = fingerprintOfDer(cert.raw);
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(want, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return new CertPinMismatchError(want, got);
  return undefined;
}

/**
 * Open a TLS socket and verify the pinned fingerprint BEFORE any request bytes
 * are written, so a bearer token is never sent to an impostor.
 *
 * Why not just `https.request({rejectUnauthorized:false, checkServerIdentity})`
 * as the P0 spike did: Node only calls `checkServerIdentity` after the chain
 * has been authorised, so with `rejectUnauthorized:false` and a self-signed
 * cert it is silently never called and ANY certificate is accepted. (Verified
 * on Node 24: a forced-mismatch `checkServerIdentity` still returned 200.)
 * Instead we finish the handshake ourselves, run `checkPinnedIdentity` on the
 * peer certificate, and only then hand the socket to `http.request` via
 * `createConnection`.
 */
export function connectPinned(opts: {
  host: string;
  port: number;
  fingerprint: string;
  timeoutMs?: number;
}): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({
      host: opts.host,
      port: opts.port,
      // Chain validation is replaced by the fingerprint pin below.
      rejectUnauthorized: false,
      // SNI must not be an IP literal (RFC 6066); omit it in that case.
      servername: net.isIP(opts.host) ? undefined : opts.host,
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`TLS connect to ${opts.host}:${opts.port} timed out`), { code: 'ETIMEDOUT' }));
    }, opts.timeoutMs ?? 10_000);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const err = checkPinnedIdentity(opts.fingerprint, sock.getPeerCertificate());
      if (err) {
        sock.destroy();
        reject(err);
        return;
      }
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
