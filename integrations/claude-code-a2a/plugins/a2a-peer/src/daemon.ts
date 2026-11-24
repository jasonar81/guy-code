/**
 * a2a-peer daemon: the user's always-on A2A endpoint (design 3, 7.2).
 *
 * One per user, started detached by the first hook or MCP server that finds
 * it missing (shared/local.ts ensureDaemon), and left running after Claude
 * Code exits so colleagues can still reach the user and approved watches
 * keep checking with no session open (acceptance criterion 2: flow 8.2 must
 * complete with Dylan's terminal closed).
 *
 * State lives in ${CLAUDE_PLUGIN_DATA}:
 *   a2a.db         sql.js database (db.ts): Guy Code's A2A tables + cc_sessions + inbox
 *   secrets.json   mode 0600: peer bearer tokens, per-task push tokens, the
 *                  TLS private key, and for rooms (design 11b) each Claude
 *                  Code session's private key (a2a.session.<id>.key) and the
 *                  room keys (a2a.room.<session>.<room>.<epoch>)
 *                  (design 4.2.1 allows "a 0600 file under
 *                  ${CLAUDE_PLUGIN_DATA}" when no keychain module is present;
 *                  we deliberately add no native dependency)
 *   daemon.json    mode 0600: { pid, port, token, a2aUrl } for the local API
 *   config.json    optional: { displayName, port, bind, allowCidrs, advertiseHost,
 *                  relayUrl, relayEnabled, relayCertSha256, listen }
 *   audit.jsonl    the append-only audit log (design 4.2.7)
 *
 * Settings come from config.json, then the plugin's userConfig, which Claude
 * Code exports to hook processes as CLAUDE_PLUGIN_OPTION_<KEY> (the hook that
 * starts us passes its environment through). Nothing secret is ever logged:
 * the local token and pairing codes stay out of stdout and the audit.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { DaemonCore } from './core';
import { openFileDb, sqlHandle } from './db';
import { startLocalApi } from './localApi';
import { DAEMON_JSON, connectDaemon, readDaemonInfo } from './shared/local';
import { isEntry } from './shared/entry';
import {
  DEFAULT_ALLOW_CIDRS,
  CLAUDE_CODE_DEFAULT_PORT,
  fingerprintOfPem,
  generateSelfSignedCert,
  normaliseRelayUrl,
  parseCidr,
  type RelayNodeOptions,
  resolveAdvertiseHost,
  resolveBindAddress,
  runConditionCheck,
  type SecretPort,
  type SqlHandle,
  type TlsIdentity,
} from './shared/protocol';

import { PLUGIN_VERSION, dataDir } from './shared/paths';
export { PLUGIN_VERSION, dataDir };

const TLS_KEY_SECRET = 'a2a.tlsKey';
const TLS_CERT_SETTING = 'a2a.tlsCert';

function writePrivate(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows: ACLs, not modes; the file is under the user's profile */
  }
}

/** A 0600 JSON file of name -> secret. Never logged. */
export function fileSecrets(path: string): SecretPort {
  let cache: Record<string, string> | null = null;
  const load = () => {
    if (cache) return cache;
    try {
      cache = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    set: (k, v) => {
      const c = load();
      c[k] = v;
      writePrivate(path, JSON.stringify(c));
      return true;
    },
    get: (k) => load()[k] ?? null,
    clear: (k) => {
      const c = load();
      delete c[k];
      writePrivate(path, JSON.stringify(c));
    },
  };
}

function getSetting(sql: SqlHandle, key: string): string | null {
  return sql.prepare('SELECT value FROM cc_settings WHERE key = ?').get<{ value: string }>(key)?.value ?? null;
}
function setSetting(sql: SqlHandle, key: string, value: string): void {
  sql.prepare('INSERT INTO cc_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Load our TLS identity, minting one on first run (same rules as Guy Code's index.ts). */
export function loadOrCreateTls(sql: SqlHandle, secrets: SecretPort, advertiseHost: string): TlsIdentity {
  const certPem = getSetting(sql, TLS_CERT_SETTING);
  const keyPem = secrets.get(TLS_KEY_SECRET);
  if (certPem && keyPem) {
    try {
      return { certPem, keyPem, fingerprint: fingerprintOfPem(certPem) };
    } catch {
      /* unreadable: mint a new one below (peers must re-pair) */
    }
  }
  const ips = Array.from(new Set(['127.0.0.1', advertiseHost].filter((h) => /^[\d.]+$/.test(h) || h.includes(':'))));
  const id = generateSelfSignedCert({ commonName: 'a2a-peer', ips, dnsNames: ['localhost'] });
  secrets.set(TLS_KEY_SECRET, id.keyPem);
  setSetting(sql, TLS_CERT_SETTING, id.certPem);
  return id;
}

export interface DaemonConfig {
  displayName: string;
  port: number;
  bind: string;
  allowCidrs: string[];
  advertiseHost?: string;
  /** Relay (design 11a). Empty URL or relayEnabled false = off. */
  relayUrl: string;
  relayEnabled: boolean;
  relayCertSha256: string;
  /** False = relay-only: never open a listening port (config.json "listen": false). */
  listen: boolean;
}

const truthy = (v: unknown) => v === true || v === 'true' || v === '1' || v === 1;

export function readConfig(dir: string, envIn: NodeJS.ProcessEnv = process.env): DaemonConfig {
  // An unset userConfig option may arrive as the literal "${user_config.x}"
  // (.mcp.json substitution); treat that as unset.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(envIn)) if (typeof v === 'string' && !v.includes('${')) env[k] = v;
  let file: Record<string, unknown> = {};
  try {
    const p = join(dir, 'config.json');
    if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    file = {};
  }
  const portRaw = Number(file.port ?? env.CLAUDE_PLUGIN_OPTION_PORT);
  const cidrs = (Array.isArray(file.allowCidrs) ? file.allowCidrs.map(String) : String(env.CLAUDE_PLUGIN_OPTION_ALLOW_CIDRS ?? '').split(/[\s,]+/)).filter(
    (c) => c && parseCidr(c) !== null
  );
  let name = String(file.displayName ?? env.CLAUDE_PLUGIN_OPTION_DISPLAY_NAME ?? '').trim();
  if (!name) {
    try {
      name = userInfo().username;
    } catch {
      name = 'Claude Code user';
    }
  }
  return {
    displayName: name,
    // Defaults to 7428, NOT Guy Code's 7427, so both can run on one machine
    // without the second one failing to bind.
    port:
      Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536
        ? portRaw
        : CLAUDE_CODE_DEFAULT_PORT,
    bind: String(file.bind ?? env.CLAUDE_PLUGIN_OPTION_BIND ?? '').trim(),
    allowCidrs: cidrs.length ? cidrs : [...DEFAULT_ALLOW_CIDRS],
    advertiseHost: typeof file.advertiseHost === 'string' ? file.advertiseHost : undefined,
    relayUrl: normaliseRelayUrl(String(file.relayUrl ?? env.CLAUDE_PLUGIN_OPTION_RELAY_URL ?? '')),
    relayEnabled: truthy(file.relayEnabled ?? env.CLAUDE_PLUGIN_OPTION_RELAY_ENABLED),
    relayCertSha256: String(file.relayCertSha256 ?? env.CLAUDE_PLUGIN_OPTION_RELAY_CERT_SHA256 ?? '')
      .replace(/[^0-9a-fA-F]/g, '')
      .toLowerCase(),
    listen: file.listen === undefined ? true : truthy(file.listen),
  };
}

const RELAY_PIN_SETTING = 'a2a.relayCertSha256';

/**
 * Relay options for the node, or null when off. With no configured pin, the
 * first certificate seen is pinned and stored (per relay URL) in cc_settings,
 * so a later certificate change is refused.
 */
export function relayOptions(cfg: DaemonConfig, sql: SqlHandle): RelayNodeOptions | null {
  if (!cfg.relayEnabled || !cfg.relayUrl) return null;
  const key = `${RELAY_PIN_SETTING}:${cfg.relayUrl}`;
  return {
    url: cfg.relayUrl,
    certSha256: cfg.relayCertSha256 || getSetting(sql, key) || null,
    onPinLearned: (fp) => setSetting(sql, key, fp),
  };
}

/** Exit after this long with no session, no local traffic and no live watch? Never: peers must reach us. */
export async function main(): Promise<void> {
  const dir = dataDir();
  // One daemon per data dir: if a healthy one already answers, step aside.
  if (await connectDaemon(dir, 800)) return;
  const cfg = readConfig(dir);
  const db = await openFileDb(join(dir, 'a2a.db'));
  const secrets = fileSecrets(join(dir, 'secrets.json'));
  const bind = resolveBindAddress({ bind: cfg.bind, allowCidrs: cfg.allowCidrs });
  const advertise = cfg.advertiseHost || resolveAdvertiseHost(bind, { allowCidrs: cfg.allowCidrs });
  const tls = loadOrCreateTls(db.sql, secrets, advertise);
  const core = new DaemonCore({
    sql: db.sql,
    secrets,
    auditPath: join(dir, 'audit.jsonl'),
    tls,
    host: bind,
    port: cfg.port,
    advertiseHost: advertise,
    // Loopback is always allowed so a Claude Code user can pair with
    // themselves or a local Guy Code for testing; the VPN range is the default.
    allowCidrs: () => [...cfg.allowCidrs, '127.0.0.0/8'],
    displayName: cfg.displayName,
    userName: cfg.displayName.toLowerCase().split(/\s+/)[0],
    appVersion: PLUGIN_VERSION,
    watchCheck: (command, cwd, shell, timeoutMs) => runConditionCheck(command, cwd || dir, shell, timeoutMs),
    relay: relayOptions(cfg, db.sql),
    listen: cfg.listen,
  });
  await core.start();
  const token = randomBytes(32).toString('base64url');
  const api = await startLocalApi(core, token);
  writePrivate(join(dir, DAEMON_JSON), JSON.stringify({ pid: process.pid, port: api.port, token, a2aUrl: core.node.origin(), version: PLUGIN_VERSION }));
  // A periodic backstop for watches (the node also arms in-process timers).
  // ...and for room identities of sessions that ended and never came back.
  const sweep = setInterval(() => {
    void core.node.sweepWatches().catch(() => {});
    void core.sweepEndedRoomSessions().catch(() => {});
  }, 60_000);
  const shutdown = async () => {
    clearInterval(sweep);
    try {
      const info = readDaemonInfo(dir);
      if (info?.pid === process.pid) unlinkSync(join(dir, DAEMON_JSON));
    } catch {
      /* already gone */
    }
    await api.close().catch(() => {});
    await core.stop().catch(() => {});
    try {
      db.flush();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdout.write(`a2a-peer daemon listening on ${core.node.origin()} (local API on 127.0.0.1)\n`);
}

// Kept for the type checker; the tests build cores directly.
export { sqlHandle };

if (isEntry('daemon')) {
  main().catch((e) => {
    process.stderr.write(`a2a-peer daemon failed to start: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
