/**
 * A2A settings and the network checks that depend on them.
 *
 * Settings live in the normal `settings` table (design 9). They are read
 * through an injected getter so this module never imports `db.ts` (and
 * through it Electron), which keeps it usable from tests and, later, from the
 * Claude Code daemon.
 *
 * Security defaults (design 4.1 / 4.2): OFF until the user turns it on, and
 * never bound to 0.0.0.0 unless the user types that in. With no explicit bind
 * address we pick the first local interface address that is inside the
 * allow-list (normally the VPN adapter), else loopback.
 */
import * as net from 'node:net';
import * as os from 'node:os';

export const A2A_SETTING = {
  enabled: 'a2a.enabled',
  port: 'a2a.port',
  bind: 'a2a.bind',
  allowCidrs: 'a2a.allowCidrs',
  displayName: 'a2a.displayName',
  insecureHttp: 'a2a.insecureHttp',
  inboxSession: 'a2a.inboxSession',
  /** Global "pause all A2A": caps every peer's effective trust at inform (design 4.2.3). */
  paused: 'a2a.paused',
  /** Our self-signed certificate (PEM). The private key goes through secret.ts, never here. */
  tlsCert: 'a2a.tlsCert',
} as const;

/** Secret name (secret.ts) for our TLS private key. */
export const A2A_TLS_KEY_SECRET = 'a2a.tlsKey';

export const DEFAULT_PORT = 7427;
export const DEFAULT_ALLOW_CIDRS = ['10.0.0.0/8'];

/** Inbound limits from design 4.2.6. */
export const LIMITS = {
  maxBodyBytes: 256 * 1024,
  maxParts: 20,
  requestsPerMinutePerPeer: 60,
  /** Pairing is unauthenticated (the invite secret is the credential), so cap it per source IP. */
  pairAttemptsPerMinutePerIp: 10,
  /** Pairing invites are single use and expire after 15 minutes (design 4.3). */
  inviteTtlMs: 15 * 60_000,
} as const;

export interface A2AConfig {
  enabled: boolean;
  port: number;
  /** Address to listen on. Empty means auto-detect (see resolveBindAddress). */
  bind: string;
  allowCidrs: string[];
  displayName: string;
  insecureHttp: boolean;
  paused: boolean;
}

type Getter = (key: string) => string | null;

function truthy(v: string | null): boolean {
  return v === '1' || v === 'true';
}

export function readA2AConfig(get: Getter): A2AConfig {
  const rawPort = Number(get(A2A_SETTING.port));
  const cidrs = String(get(A2A_SETTING.allowCidrs) ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((c) => parseCidr(c) !== null);
  return {
    enabled: truthy(get(A2A_SETTING.enabled)),
    port: Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_PORT,
    bind: String(get(A2A_SETTING.bind) ?? '').trim(),
    allowCidrs: cidrs.length ? cidrs : [...DEFAULT_ALLOW_CIDRS],
    displayName: String(get(A2A_SETTING.displayName) ?? '').trim() || os.userInfo().username,
    insecureHttp: truthy(get(A2A_SETTING.insecureHttp)),
    paused: truthy(get(A2A_SETTING.paused)),
  };
}

// ---- CIDR allow-list ---------------------------------------------------------

interface Cidr {
  bytes: Buffer;
  prefix: number;
}

/** Strip the IPv4-mapped prefix Node reports on dual-stack sockets ("::ffff:10.1.2.3"). */
export function normaliseRemoteAddress(addr: string | undefined): string {
  const a = String(addr ?? '');
  const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : a;
}

function addrBytes(ip: string): Buffer | null {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) return null;
  // Expand "::" by hand. Embedded dotted IPv4 tails are rejected (they only
  // reach us as "::ffff:a.b.c.d", which normaliseRemoteAddress already folds).
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  if (h.some((g) => g.includes('.')) || t.some((g) => g.includes('.'))) return null;
  const fill = tail !== undefined ? new Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  const groups = [...h, ...fill, ...t];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

export function parseCidr(c: string): Cidr | null {
  const [ip, p] = c.split('/');
  const bytes = addrBytes(ip);
  if (!bytes) return null;
  const max = bytes.length * 8;
  const prefix = p === undefined ? max : Number(p);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { bytes, prefix };
}

/**
 * True when `addr` falls inside any of `cidrs`. Fails closed: an address we
 * cannot parse never matches.
 */
export function ipInCidrs(addr: string, cidrs: string[]): boolean {
  const ip = addrBytes(normaliseRemoteAddress(addr));
  if (!ip) return false;
  for (const c of cidrs) {
    const parsed = parseCidr(c);
    if (!parsed || parsed.bytes.length !== ip.length) continue;
    let bits = parsed.prefix;
    let ok = true;
    for (let i = 0; i < ip.length && bits > 0; i++) {
      const take = Math.min(8, bits);
      const mask = (0xff << (8 - take)) & 0xff;
      if ((ip[i] & mask) !== (parsed.bytes[i] & mask)) {
        ok = false;
        break;
      }
      bits -= take;
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Where to listen. An explicit `a2a.bind` wins (including "0.0.0.0" if the
 * user deliberately typed it; the CIDR allow-list still applies). Otherwise
 * the first non-internal IPv4 address inside the allow-list, which on a VPN
 * laptop is the VPN adapter. Falling back to loopback means a misconfigured
 * allow-list makes the endpoint unreachable rather than exposed.
 */
export function resolveBindAddress(cfg: Pick<A2AConfig, 'bind' | 'allowCidrs'>, ifaces = os.networkInterfaces()): string {
  if (cfg.bind) return cfg.bind;
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.internal || i.family !== 'IPv4') continue;
      if (ipInCidrs(i.address, cfg.allowCidrs)) return i.address;
    }
  }
  return '127.0.0.1';
}

/**
 * The host we put in our card URL. A wildcard bind is not dialable, so in
 * that case advertise the auto-detected interface address instead.
 */
export function resolveAdvertiseHost(bindAddr: string, cfg: Pick<A2AConfig, 'allowCidrs'>): string {
  if (bindAddr === '0.0.0.0' || bindAddr === '::') return resolveBindAddress({ bind: '', allowCidrs: cfg.allowCidrs });
  return bindAddr;
}
