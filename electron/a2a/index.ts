/**
 * App wiring for A2A: builds the one A2ANode for this Guy Code instance from
 * the real database, secret storage and agent loop, and starts / stops it from
 * settings. Everything protocol-level lives in the Electron-free modules next
 * to this file; this is the only one that imports Electron or agent.ts.
 *
 * Imported lazily (dynamic import) from tools, IPC and agent.ts so the
 * agent -> tools -> a2a -> agent cycle never forms at module load.
 *
 * P2 adds the WaitForA2A glue: the WaitPort the node uses to wake sleeping
 * sessions on a push, `a2aTimerWake` for agent.ts's timer path (poll
 * backstop, then resume or re-sleep), and the approval notifications
 * (desktop + Agents-panel event + Slack line).
 *
 * P3 hands the node tools.ts's `runConditionCheck` for watches and exports
 * `a2aSweepWatches` for the budget governor's 60 s sweep.
 */
import { app, BrowserWindow, dialog, Notification } from 'electron';
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
  getSessionById,
  setSessionState,
  setSessionApiKey,
  setSessionWaitA2A,
  getSessionWaitA2A,
  listSessionsWaitingA2A,
  setSessionWakeAt,
  upsertSession,
  upsertProject,
} from '../db';
import { getSecret, setSecret, clearSecret, getDefaultApiKeyId } from '../secret';
import { runUserTurn, queueInterrupt, isRunning } from '../agent';
import { runConditionCheck } from '../tools';
import { loadMessagesFromJsonl, ourJsonlPath } from '../sessionRuntime';
import { setEscalationUi } from '../a2aTools';
import type { TrustLevel } from './types';
import { broadcastAgentEvent, broadcastStateChanged } from '../agentEvents';
import { resolveSession, postSlackLine } from '../slackBridge';
import { decideTimerWake, messageConcerns, renameInWait, type WaitA2AState, type WaitPort } from './waiters';
import type { PeerRow, TaskRow } from './store';
import { A2A_SETTING, A2A_TLS_KEY_SECRET, readA2AConfig, resolveAdvertiseHost, resolveBindAddress } from './config';
import { generateSelfSignedCert, fingerprintOfPem, type TlsIdentity } from './tls';
import { A2ANode } from './node';
import { relayNoteForPeer } from './relayCrypto';
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
  notify: (title, body) => desktopNotify(title, body),
  isWaitingFor: (sessionId, on) => {
    const w = getSessionWaitA2A(sessionId);
    if (!w) return false;
    const ctxs = _node ? w.taskIds.map((id) => _node!.store.getTask(id)?.context_id).filter((x): x is string => !!x) : [];
    return messageConcerns(w, on, ctxs);
  },
};

function desktopNotify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch {
    /* notifications are a nicety */
  }
}

/**
 * Resume a session that was sleeping in WaitForA2A. Clears the wait first so
 * a second event cannot resume it twice, then starts the turn with the note
 * (runUserTurn also cancels the armed wake timer).
 */
function resumeWaiter(sessionId: string, note: string): void {
  const row = getSessionById(sessionId);
  if (!row || row.archived === 1) return;
  setSessionWaitA2A(sessionId, null);
  if (row.state !== 'sleeping-tool' || isRunning(sessionId)) {
    // Not actually asleep (the user started a turn meanwhile): hand the news
    // over without starting a second turn.
    queueInterrupt(sessionId, note);
    return;
  }
  setSessionWakeAt(sessionId, null);
  log.info(`[a2a] waking ${sessionId}: ${note.slice(0, 120)}`);
  void runUserTurn({
    sessionId,
    projectId: row.project_id,
    cwd: row.cwd ?? '',
    userText: note,
    continueExisting: true,
    seedFromJsonl: row.jsonl_path,
  }).catch((e) => log.error('[a2a] resume after WaitForA2A failed', e));
}

const waitPort: WaitPort = {
  listWaiting: () =>
    listSessionsWaitingA2A().flatMap((r) => {
      try {
        const state = JSON.parse(r.wait_a2a) as WaitA2AState;
        return state && typeof state.deadlineTs === 'number' ? [{ sessionId: r.id, state }] : [];
      } catch {
        return [];
      }
    }),
  resume: resumeWaiter,
  renameTask: (from, to) => {
    for (const r of listSessionsWaitingA2A()) {
      try {
        const next = renameInWait(JSON.parse(r.wait_a2a), from, to);
        if (next) setSessionWaitA2A(r.id, next);
      } catch {
        /* skip malformed */
      }
    }
  },
};

/**
 * agent.ts timer path for a session sleeping in WaitForA2A (design 6.4).
 * Returns the note to resume with, or the next wake time. With A2A off the
 * wait cannot progress, so it resumes with an explanation rather than
 * sleeping until the deadline.
 */
export async function a2aTimerWake(state: WaitA2AState): Promise<{ note: string } | { sleepUntil: number }> {
  const n = _node;
  if (!n || !n.isRunning()) {
    return { note: '[WaitForA2A] stopped waiting: A2A has been turned off, so no answer can arrive. Tell the user.' };
  }
  return decideTimerWake((s) => n.pollForWait(s, s.pollStaleMs), state, Date.now());
}

/**
 * Governor sweep hook for A2A watches (design 5.5): runs any watch check that
 * is due and re-arms the in-process timers. The node already sweeps once on
 * start; this 60 s backstop covers a lost timer and a machine waking from
 * suspend, exactly like wakeSleepingToolSweep does for WaitForCondition.
 * No-op while A2A is off: a watch then waits (its state stays in the DB) and
 * resumes the next time A2A starts.
 */
export async function a2aSweepWatches(): Promise<void> {
  const n = _node;
  if (!n || !n.isRunning()) return;
  await n.sweepWatches();
}

/**
 * The last thing the USER typed in a session (not a tool result, not an
 * injected A2A envelope wrapper we can tell apart). Used by A2APair's
 * escalation check (design 4.2.3: "full" only when the user's own turn says
 * so). Reads the session JSONL, which already holds the current turn.
 */
function lastUserText(sessionId: string): string | null {
  try {
    const msgs = loadMessagesFromJsonl(ourJsonlPath(sessionId));
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      const texts = (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === 'text' && b.text).map((b) => b.text!);
      if (texts.length) return texts.join('\n');
    }
    return null;
  } catch {
    return null;
  }
}

/** Native, modal confirm naming the peer and the consequences (design 4.2.3). */
export async function confirmEscalation(peer: { peer_id: string; display_name: string | null }, level: TrustLevel, expiresAt: number | null): Promise<boolean> {
  const who = peer.display_name || peer.peer_id;
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const consequence =
    level === 'full'
      ? `${who}'s agent will be able to make your agent run commands, edit files, and change shared systems without asking you.`
      : `${who}'s agent's requests will be delivered to your agent without asking you first. Your agent may act on reasonable ones, and must still ask before destructive or shared-resource actions.`;
  const until = expiresAt ? `\n\nThis lasts until ${new Date(expiresAt).toLocaleString()}, then reverts.` : '';
  const opts = {
    type: 'warning' as const,
    buttons: ['Cancel', `Give ${level} trust`],
    defaultId: 0,
    cancelId: 0,
    title: 'Raise A2A trust',
    message: `Raise ${who} to "${level}" trust?`,
    detail: consequence + until + '\n\nYou can lower it again at any time in the Agents panel, or pause all A2A.',
  };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

setEscalationUi({ lastUserText, confirm: confirmEscalation });

function onApprovalNeeded(task: TaskRow, peer: PeerRow, text: string): void {
  const who = peer.display_name || peer.peer_id;
  const short = task.task_id.slice(0, 8);
  const gist = text.replace(/\s+/g, ' ').trim().slice(0, 160);
  desktopNotify(`${who}'s agent asks (${task.kind})`, `${gist}\nApprove or decline in Agents.`);
  broadcastAgentEvent({ type: 'a2a_changed', reason: 'approval', taskId: task.task_id });
  // Slack bridge line (design 6.3): lets the user approve from their phone.
  void postSlackLine(
    `*${who}'s agent asks* (${task.kind}, task \`${short}\`): ${gist}\n` +
      `Reply \`Guy, accept a2a ${short}\` or \`Guy, decline a2a ${short}\`.`
  ).catch(() => {});
}

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
      waits: waitPort,
      onApprovalNeeded,
      onChange: () => broadcastAgentEvent({ type: 'a2a_changed' }),
      displayName: cfg.displayName,
      userName: userInfo().username,
      agentKind: 'guycode',
      appVersion: app.getVersion(),
      log,
      // Watches (design 5.5) run on the WaitForCondition runner: same shells,
      // same WSL routing for bash on Windows, same 60 s per-check cap.
      watchCheck: (command, cwd, shell, timeoutMs) => runConditionCheck(command, cwd || process.cwd(), shell, timeoutMs),
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

// ---- Agents panel (design 6.7) ---------------------------------------------

export interface A2APanelPeer {
  peerId: string;
  displayName: string | null;
  agentKind: string | null;
  cardUrl: string;
  trust: TrustLevel;
  effectiveTrust: TrustLevel;
  trustPrev: TrustLevel | null;
  trustExpiresTs: number | null;
  lastSeenTs: number | null;
  queued: number;
  /** Why the relay cannot carry traffic for this peer (e.g. "re-pair"), or null. */
  relayNote: string | null;
}
export interface A2APanelTask {
  taskId: string;
  peerId: string;
  direction: 'in' | 'out';
  kind: string | null;
  state: string;
  approval: string | null;
  summary: string | null;
  sessionId: string | null;
  lastText: string;
  updatedTs: number | null;
}
export interface A2APanelSnapshot {
  running: boolean;
  paused: boolean;
  peers: A2APanelPeer[];
  pending: A2APanelTask[];
  tasks: A2APanelTask[];
}

function panelTask(t: TaskRow): A2APanelTask {
  let lastText = '';
  try {
    const st = JSON.parse(t.last_status_json ?? 'null');
    lastText = (st?.message?.parts ?? []).map((p: any) => p.text ?? '').join(' ').trim();
    if (!lastText && t.artifacts_json) {
      lastText = JSON.parse(t.artifacts_json).flatMap((a: any) => a.parts ?? []).map((p: any) => p.text ?? JSON.stringify(p.data)).join(' ');
    }
  } catch {
    /* keep empty */
  }
  return {
    taskId: t.task_id,
    peerId: t.peer_id,
    direction: t.direction,
    kind: t.kind,
    state: t.state,
    approval: t.approval ?? null,
    summary: t.summary,
    sessionId: t.session_id,
    lastText: lastText.slice(0, 400),
    updatedTs: t.updated_ts,
  };
}

/** Everything the Agents panel shows. Never includes tokens. */
export function a2aPanelSnapshot(): A2APanelSnapshot {
  const n = _node;
  const paused = readA2AConfig(getSetting).paused;
  if (!n || !n.isRunning()) return { running: false, paused, peers: [], pending: [], tasks: [] };
  const peers = n.store.listPeers().map((p) => ({
    peerId: p.peer_id,
    displayName: p.display_name,
    agentKind: p.agent_kind,
    cardUrl: p.card_url,
    trust: p.trust,
    effectiveTrust: n.effectiveTrust(p),
    trustPrev: p.trust_prev,
    trustExpiresTs: p.trust_expires_ts,
    lastSeenTs: p.last_seen_ts,
    queued: n.store.listOutbox(p.peer_id).length,
    relayNote: relayNoteForPeer(p),
  }));
  return {
    running: true,
    paused,
    peers,
    pending: n.pendingApprovals().map(panelTask),
    tasks: n.store.listTasks({ limit: 100 }).map(panelTask),
  };
}

/**
 * Trust change from the Agents panel. Raising trust goes through the same
 * native confirm the A2APair tool uses: the panel's own dialog is a
 * convenience, this one is the guarantee (a compromised renderer cannot skip it).
 */
export async function a2aPanelSetTrust(peerId: string, trust: TrustLevel, expiresInMs: number | null): Promise<{ ok: boolean; message: string }> {
  const n = requireA2ANode();
  const peer = n.resolvePeer(peerId);
  const expiresAt = expiresInMs && expiresInMs > 0 ? Date.now() + expiresInMs : null;
  const order: TrustLevel[] = ['blocked', 'inform', 'collaborate', 'full'];
  if (order.indexOf(trust) > order.indexOf(peer.trust) && order.indexOf(trust) >= 2) {
    if (!(await confirmEscalation(peer, trust, expiresAt))) return { ok: false, message: 'Not changed.' };
  }
  n.setTrust(peer.peer_id, trust, { expiresAt, by: 'user' });
  return { ok: true, message: `${peer.peer_id} is now ${trust}.` };
}

export function a2aPanelAccept(taskId: string, sessionId?: string): { ok: boolean; message: string } {
  const r = requireA2ANode().accept(taskId, { sessionId, by: 'user' });
  return { ok: true, message: `Delivered to the session (${r.delivery.mode}).` };
}

export function a2aPanelDecline(taskId: string, reason?: string): { ok: boolean; message: string } {
  requireA2ANode().decline(taskId, { reason, by: 'user' });
  return { ok: true, message: 'Declined; their agent has been told.' };
}

export function a2aPanelSetPaused(paused: boolean): void {
  setSetting(A2A_SETTING.paused, paused ? '1' : '');
  _node?.audit.write({ event: 'trust.changed', peer: '*', paused, by: 'user' });
  broadcastAgentEvent({ type: 'a2a_changed' });
}

export function a2aPanelInvite(): { code: string; expires: number } {
  return requireA2ANode().invite();
}

export async function a2aPanelRevoke(peerId: string): Promise<void> {
  await requireA2ANode().revoke(peerId);
}

export function a2aPanelAudit(limit = 300): Array<Record<string, unknown>> {
  return _node ? _node.audit.tail(Math.max(1, Math.min(limit, 2000))) : [];
}

/** Snapshot for the Settings panel. Never includes tokens. */
export function a2aStatus(): { running: boolean; url: string | null; fingerprint: string | null; peers: number; paused: boolean; pending: number } {
  const n = _node;
  return {
    running: !!n?.isRunning(),
    url: n?.isRunning() ? n.cardUrl() : null,
    fingerprint: n?.isRunning() ? n.fingerprint() : null,
    peers: n ? n.store.listPeers().length : 0,
    paused: readA2AConfig(getSetting).paused,
    pending: n?.isRunning() ? n.pendingApprovals().length : 0,
  };
}
