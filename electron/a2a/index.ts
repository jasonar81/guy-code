/**
 * App wiring for A2A: builds the one A2ANode for this Guy Code instance from
 * the real database, secret storage and agent loop, and starts / stops it from
 * settings. Everything protocol-level lives in the Electron-free modules next
 * to this file; this is the only one that imports Electron or agent.ts.
 *
 * Imported lazily (dynamic import) from tools and IPC so the agent -> tools ->
 * a2a -> agent cycle never forms at module load.
 */
import { app, Notification } from 'electron';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import {
  db,
  getDataDir,
  getSetting,
  setSetting,
  listSessionsAll,
  setSessionState,
  setSessionApiKey,
  upsertSession,
  upsertProject,
} from '../db';
import { getSecret, setSecret, clearSecret, getDefaultApiKeyId } from '../secret';
import { runUserTurn, queueInterrupt, isRunning } from '../agent';
import { ourJsonlPath } from '../sessionRuntime';
import { broadcastStateChanged } from '../agentEvents';
import { resolveSession } from '../slackBridge';
import { A2A_SETTING, A2A_TLS_KEY_SECRET, readA2AConfig, resolveAdvertiseHost, resolveBindAddress } from './config';
import { generateSelfSignedCert, fingerprintOfPem, type TlsIdentity } from './tls';
import { A2ANode } from './node';
import type { RoutableSession, SessionPort } from './router';
import type { SqlHandle } from './store';

let _node: A2ANode | null = null;
let _starting: Promise<void> | null = null;

/**
 * Load our TLS identity, minting one on first run. The certificate is public
 * (it goes in a setting); the private key goes through secret.ts (OS keychain
 * via safeStorage). If either half is missing or they no longer belong
 * together we mint a fresh pair, which changes the fingerprint and means
 * existing peers must re-pair; that is logged loudly.
 */
function loadOrCreateTlsIdentity(advertiseHost: string): TlsIdentity {
  const certPem = getSetting(A2A_SETTING.tlsCert);
  const keyPem = getSecret(A2A_TLS_KEY_SECRET);
  if (certPem && keyPem) {
    try {
      return { certPem, keyPem, fingerprint: fingerprintOfPem(certPem) };
    } catch (e) {
      log.warn('[a2a] stored TLS certificate is unreadable; generating a new one (peers must re-pair)', e);
    }
  }
  const ips = Array.from(new Set(['127.0.0.1', advertiseHost].filter((h) => /^[\d.]+$/.test(h) || h.includes(':'))));
  const id = generateSelfSignedCert({ commonName: 'guycode-a2a', ips, dnsNames: ['localhost'] });
  if (!setSecret(A2A_TLS_KEY_SECRET, id.keyPem)) {
    throw new Error('Cannot store the A2A TLS key: OS secure storage is unavailable.');
  }
  setSetting(A2A_SETTING.tlsCert, id.certPem);
  log.info(`[a2a] generated TLS identity, sha256 ${id.fingerprint.slice(0, 16)}...`);
  return id;
}

function label(s: RoutableSession): string {
  return (s.user_title || s.title || '').trim();
}

/** Production SessionPort: the same calls the Slack bridge "send" command makes. */
const sessionPort: SessionPort = {
  listSessions: () => listSessionsAll(),
  resolveSession: (rows, ref) => resolveSession(rows as any, ref),
  isRunning: (id) => isRunning(id),
  queueInterrupt: (id, text) => {
    queueInterrupt(id, text);
  },
  startTurn: (s, text) => {
    void runUserTurn({
      sessionId: s.id,
      projectId: s.project_id,
      cwd: s.cwd ?? '',
      userText: text,
      continueExisting: true,
      seedFromJsonl: s.jsonl_path,
    }).catch((e) => log.error('[a2a] runUserTurn failed', e));
  },
  getOrCreateInboxSession: () => {
    const wanted = String(getSetting(A2A_SETTING.inboxSession) ?? '');
    const rows = listSessionsAll().filter((r) => r.archived === 0);
    const existing = (wanted && rows.find((r) => r.id === wanted)) || rows.find((r) => label(r) === 'A2A inbox');
    if (existing) return existing;
    // Mirrors slackBridge "new session": the shared cwd-less project and the
    // default API key, so the session can run immediately.
    const id = randomUUID();
    const projectId = '__guy_default__';
    upsertProject({ id: projectId, cwd: '', lastActivityTs: Date.now(), createdAt: Date.now() });
    upsertSession({
      id,
      projectId,
      jsonlPath: ourJsonlPath(id),
      jsonlMtime: Date.now(),
      jsonlSize: 0,
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 0,
      lastMessagePreview: null,
      title: 'A2A inbox',
    });
    setSessionState(id, 'idle');
    const defKey = getDefaultApiKeyId();
    if (defKey) setSessionApiKey(id, defKey);
    setSetting(A2A_SETTING.inboxSession, id);
    broadcastStateChanged(id, 'idle');
    const row = listSessionsAll().find((r) => r.id === id);
    if (!row) throw new Error('failed to create the A2A inbox session');
    return row;
  },
  notify: (title, body) => {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch {
      /* notifications are a nicety */
    }
  },
};

export function getA2ANode(): A2ANode | null {
  return _node;
}

/** The running node, or a plain-English error for the tools to return. */
export function requireA2ANode(): A2ANode {
  if (!_node || !_node.isRunning()) {
    throw new Error(
      'A2A is turned off. The user can enable it in Settings -> Agent-to-agent (A2A). It is off by default because it opens a network port.'
    );
  }
  return _node;
}

/** (Re)start from current settings. Safe to call repeatedly; a no-op when disabled. */
export async function startA2A(): Promise<void> {
  if (_starting) await _starting.catch(() => {});
  _starting = (async () => {
    await stopA2A();
    const cfg = readA2AConfig(getSetting);
    if (!cfg.enabled) {
      log.info('[a2a] disabled');
      return;
    }
    const host = resolveBindAddress(cfg);
    const advertiseHost = resolveAdvertiseHost(host, cfg);
    const tls = cfg.insecureHttp ? null : loadOrCreateTlsIdentity(advertiseHost);
    const node = new A2ANode({
      sql: db() as unknown as SqlHandle,
      secrets: { set: setSecret, get: getSecret, clear: clearSecret },
      sessions: sessionPort,
      auditPath: join(getDataDir(), 'a2a', 'audit.jsonl'),
      tls,
      host,
      port: cfg.port,
      advertiseHost,
      insecureHttp: cfg.insecureHttp,
      // Read live so a settings change applies without a restart.
      allowCidrs: () => readA2AConfig(getSetting).allowCidrs,
      isPaused: () => readA2AConfig(getSetting).paused,
      displayName: cfg.displayName,
      userName: userInfo().username,
      agentKind: 'guycode',
      appVersion: app.getVersion(),
      log,
    });
    await node.start();
    _node = node;
    log.info(`[a2a] listening on ${node.origin()} (bind ${host}, allow ${cfg.allowCidrs.join(',')})`);
  })();
  try {
    await _starting;
  } finally {
    _starting = null;
  }
}

export async function stopA2A(): Promise<void> {
  const n = _node;
  _node = null;
  if (n) await n.stop().catch((e) => log.warn('[a2a] stop failed', e));
}

/** Snapshot for the Settings panel. Never includes tokens. */
export function a2aStatus(): { running: boolean; url: string | null; fingerprint: string | null; peers: number } {
  const n = _node;
  return {
    running: !!n?.isRunning(),
    url: n?.isRunning() ? n.cardUrl() : null,
    fingerprint: n?.isRunning() ? n.fingerprint() : null,
    peers: n ? n.store.listPeers().length : 0,
  };
}
