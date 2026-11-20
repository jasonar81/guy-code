/**
 * One A2A endpoint: server + client + store + router + audit, wired together.
 *
 * This is the Electron-free core. `./index.ts` builds one for the app from
 * the real DB, secret storage and agent.ts; the tests build two of them in
 * one process against throwaway sql.js databases and talk real TLS between
 * them. Keeping the seam here is what lets the tests exercise the actual
 * server instead of a mock.
 */
import { randomUUID } from 'node:crypto';
import { A2AProtocolError, errors } from './errors';
import { AuditLog } from './audit';
import { LIMITS } from './config';
import { createA2AServer, type A2AServer } from './server';
import { A2AStore, type PeerRow, type SecretPort, type SqlHandle, type TaskRow } from './store';
import { deliver, type DeliveryResult, type SessionPort } from './router';
import { acceptPair, createInvite, redeemCode, type LocalIdentity } from './pairing';
import { baseUrlOf, fetchExtendedCard, sendMessage, PeerOfflineError } from './client';
import type { TlsIdentity } from './tls';
import {
  A2A_PROTOCOL_VERSION,
  EXT_PAIRING,
  EXT_ROUTING,
  ROUTING_METADATA_KEY,
  TERMINAL_STATES,
  type AgentCard,
  type AgentKind,
  type Message,
  type MessageKind,
  type RoutingInfo,
  type SendMessageRequest,
  type Task,
  type TaskState,
  type TrustLevel,
} from './types';

export interface A2ANodeOptions {
  sql: SqlHandle;
  secrets: SecretPort;
  sessions: SessionPort;
  auditPath: string;
  tls: TlsIdentity | null;
  host: string;
  port: number;
  /** Host to put in our card URL (the dialable address). Defaults to `host`. */
  advertiseHost?: string;
  insecureHttp?: boolean;
  allowCidrs: () => string[];
  displayName: string;
  /** Local user name for the routing extension's `fromUser`. */
  userName?: string;
  agentKind?: AgentKind;
  appVersion?: string;
  /** Global "pause all A2A": caps effective trust at inform. */
  isPaused?: () => boolean;
  now?: () => number;
  /** Pairing verifies the redeemer's card by default; tests can switch it off. */
  verifyPeerCardOnPair?: boolean;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}

export interface SendResult {
  peer: PeerRow;
  taskId: string;
  contextId: string;
  state: TaskState;
}

export interface PeerStatus {
  peer: PeerRow;
  online: boolean;
  sessions?: unknown;
}

const VALID_KINDS: readonly MessageKind[] = ['inform', 'request', 'notify'];

/** Pairing codes are secrets (design 4.2.3 item 5): never let one leave in a message body. */
const PAIRING_CODE_RE = /a2a1:[A-Za-z0-9_-]{20,}/;

export class A2ANode {
  readonly store: A2AStore;
  readonly audit: AuditLog;
  private server: A2AServer | null = null;
  private readonly now: () => number;
  private readonly agentKind: AgentKind;

  constructor(private readonly opts: A2ANodeOptions) {
    this.store = new A2AStore(opts.sql, opts.secrets);
    this.audit = new AuditLog(opts.auditPath);
    this.now = opts.now ?? Date.now;
    this.agentKind = opts.agentKind ?? 'guycode';
  }

  // ---- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    if (this.server) return;
    if (!this.opts.insecureHttp && !this.opts.tls) throw new Error('A2A needs a TLS identity (or insecureHttp for tests).');
    const server = createA2AServer({
      host: this.opts.host,
      port: this.opts.port,
      tls: this.opts.tls ? { certPem: this.opts.tls.certPem, keyPem: this.opts.tls.keyPem } : undefined,
      insecureHttp: this.opts.insecureHttp,
      allowCidrs: this.opts.allowCidrs,
      now: this.now,
      handlers: {
        authenticate: (t) => this.store.findPeerByInboundToken(t),
        effectiveTrust: (p) => this.effectiveTrust(p),
        card: () => this.card(),
        extendedCard: (p) => this.extendedCard(p),
        sendMessage: async (p, req) => this.onSendMessage(p, req),
        getTask: (p, id) => this.onGetTask(p, id),
        cancelTask: (p, id) => this.onCancelTask(p, id),
        pair: async (req, remote) => {
          try {
            const { response, peer } = await acceptPair(this.store, req, this.identity(), {
              allowHttp: !!this.opts.insecureHttp,
              now: this.now(),
              verifyPeerCard: this.opts.verifyPeerCardOnPair,
            });
            this.audit.write({ event: 'pair.accepted', peer: peer.peer_id, displayName: peer.display_name, cardUrl: peer.card_url, remote });
            return response;
          } catch (e) {
            this.audit.write({ event: 'pair.rejected', remote, reason: (e as A2AProtocolError).reason ?? 'error' });
            throw e;
          }
        },
        onRejected: (info) => this.audit.write({ event: 'inbound.rejected', ...info }),
      },
    });
    await server.start();
    this.server = server;
    this.audit.write({ event: 'server.started', url: this.origin() });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) {
      await s.stop();
      this.audit.write({ event: 'server.stopped' });
    }
  }

  isRunning(): boolean {
    return !!this.server;
  }

  origin(): string {
    if (!this.server) throw new Error('A2A server is not running');
    return this.server.origin(this.opts.advertiseHost);
  }

  cardUrl(): string {
    return `${this.origin()}/.well-known/agent-card.json`;
  }

  fingerprint(): string {
    return this.opts.tls?.fingerprint ?? '0'.repeat(64);
  }

  identity(): LocalIdentity {
    return { cardUrl: this.cardUrl(), certSha256: this.fingerprint(), displayName: this.opts.displayName, agentKind: this.agentKind };
  }

  // ---- cards ---------------------------------------------------------------

  card(): AgentCard {
    const who = this.opts.displayName;
    return {
      name: `${who}'s agents`,
      description: `Guy Code agents for ${who}. Coordination only; pair first.`,
      // Our HTTP+JSON routes live at the origin root, so that is the interface URL.
      supportedInterfaces: [{ url: this.origin(), protocolBinding: 'HTTP+JSON', protocolVersion: A2A_PROTOCOL_VERSION }],
      version: `guycode-${this.opts.appVersion ?? 'dev'}`,
      capabilities: {
        streaming: false,
        // TODO(P2): true once /a2a-push and outbound push delivery exist.
        pushNotifications: false,
        extendedAgentCard: true,
        extensions: [
          { uri: EXT_ROUTING, required: false, description: 'Target a specific session/project; carry sender session label.' },
          { uri: EXT_PAIRING, required: false, description: 'Pairing handshake at /a2a-pair.' },
        ],
      },
      securitySchemes: { peerBearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { peerBearer: { list: [] } } }],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{ id: 'inform', name: 'Inform', description: "Tell this user's agent something.", tags: ['fyi'] }],
    };
  }

  extendedCard(_peer: PeerRow): AgentCard & Record<string, unknown> {
    // TODO(P2): add the `sessions` list (design 5.1) once per-session exposure
    // ("a2a.exposeSessions") has a UI. Until then expose nothing.
    return { ...this.card(), sessions: [] };
  }

  // ---- trust ---------------------------------------------------------------

  /**
   * Trust that applies right now: time-boxed escalations revert at expiry
   * (audited), and a global pause caps everything at inform.
   */
  effectiveTrust(peer: PeerRow): TrustLevel {
    let t = peer.trust;
    if (peer.trust_expires_ts && this.now() >= peer.trust_expires_ts) {
      const back: TrustLevel = peer.trust_prev && peer.trust_prev !== peer.trust ? peer.trust_prev : 'inform';
      this.store.setTrust(peer.peer_id, back, { expiresTs: null, now: this.now() });
      this.audit.write({ event: 'trust.expired', peer: peer.peer_id, from: t, to: back });
      t = back;
    }
    if (this.opts.isPaused?.() && t !== 'blocked') t = 'inform';
    return t;
  }

  // ---- inbound -------------------------------------------------------------

  private validateMessage(req: SendMessageRequest): Message {
    const msg = req?.message;
    if (!msg || typeof msg !== 'object') throw errors.badRequest('message is required.');
    if (typeof msg.messageId !== 'string' || !msg.messageId || msg.messageId.length > 200) {
      throw errors.badRequest('message.messageId is required.');
    }
    if (!Array.isArray(msg.parts) || msg.parts.length === 0) throw errors.badRequest('message.parts must be a non-empty array.');
    if (msg.parts.length > LIMITS.maxParts) throw errors.badRequest(`At most ${LIMITS.maxParts} parts per message.`);
    for (const p of msg.parts) {
      if (!p || typeof p !== 'object') throw errors.badRequest('Each part must be an object.');
      if (p.raw !== undefined || p.url !== undefined || p.file !== undefined) {
        throw errors.badRequest('File parts are not accepted. Share a path, branch or URL as text instead.');
      }
      if (p.text === undefined && p.data === undefined) throw errors.badRequest('Each part needs text or data.');
      if (p.text !== undefined && typeof p.text !== 'string') throw errors.badRequest('part.text must be a string.');
    }
    if (msg.contextId !== undefined && (typeof msg.contextId !== 'string' || msg.contextId.length > 200)) {
      throw errors.badRequest('message.contextId must be a string.');
    }
    return msg;
  }

  private async onSendMessage(peer: PeerRow, req: SendMessageRequest): Promise<Task> {
    const msg = this.validateMessage(req);
    const trust = this.effectiveTrust(peer);
    this.store.touchPeer(peer.peer_id, this.now());

    // Dedup (design 4.2.5): a retried message returns the task it already made.
    const seen = this.store.seenMessage(peer.peer_id, msg.messageId);
    if (seen !== null) {
      this.audit.write({ event: 'inbound.duplicate', peer: peer.peer_id, messageId: msg.messageId, taskId: seen });
      const t = seen ? this.store.getTask(seen) : undefined;
      if (t) return this.toTask(t);
      throw errors.badRequest('Duplicate messageId.');
    }

    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    const kindRaw = typeof meta.kind === 'string' ? meta.kind : 'inform';
    const kind: MessageKind = (VALID_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as MessageKind) : 'inform';

    if (msg.taskId) {
      // Follow-ups to a live task belong to request/notify (P2). Inform tasks
      // complete immediately, so any taskId we know is terminal.
      const t = this.store.getTask(msg.taskId);
      if (!t || t.peer_id !== peer.peer_id) throw errors.taskNotFound(msg.taskId);
      if (TERMINAL_STATES.has(t.state)) throw errors.unsupportedOperation(`Task ${msg.taskId} is already finished; send a new message instead.`);
    }

    // contextId: reuse the peer's, but never let one peer write into another
    // peer's conversation.
    let contextId = msg.contextId || '';
    let mappedSessionId: string | null = null;
    if (contextId) {
      const ctx = this.store.getContext(contextId);
      if (ctx && ctx.peer_id !== peer.peer_id) throw errors.badRequest('contextId belongs to a different conversation.');
      mappedSessionId = ctx?.session_id ?? null;
    } else {
      contextId = randomUUID();
    }

    const routingRaw = meta[ROUTING_METADATA_KEY];
    const routing: RoutingInfo = routingRaw && typeof routingRaw === 'object' && !Array.isArray(routingRaw) ? (routingRaw as RoutingInfo) : {};
    const text = msg.parts
      .map((p) => (p.text !== undefined ? p.text : '```json\n' + JSON.stringify(p.data, null, 2) + '\n```'))
      .join('\n\n');

    // deliver() gates before it routes or touches a session, and we only write
    // the task row after it succeeds, so a refused kind leaves nothing behind
    // and is not recorded as seen (the peer may resend it as inform).
    const taskId = randomUUID();
    let result: DeliveryResult;
    try {
      result = deliver(this.opts.sessions, { peer, trust, kind, contextId, taskId, text, routing, mappedSessionId });
    } catch (e) {
      this.audit.write({ event: 'inbound.rejected', peer: peer.peer_id, kind, reason: (e as A2AProtocolError).reason ?? String(e) });
      throw e;
    }

    // Inform tasks complete immediately (design 5.2): there is no lifecycle,
    // the message has been handed to a session.
    const state: TaskState = 'TASK_STATE_COMPLETED';
    const status = { state, timestamp: new Date(this.now()).toISOString() };
    this.store.insertTask({
      taskId,
      peerId: peer.peer_id,
      direction: 'in',
      contextId,
      sessionId: result.sessionId,
      kind,
      state,
      summary: text.slice(0, 200),
      requestJson: JSON.stringify(msg),
      statusJson: JSON.stringify(status),
      now: this.now(),
    });
    this.store.setContext(contextId, peer.peer_id, result.sessionId, this.now());
    this.store.recordSeenMessage(peer.peer_id, msg.messageId, taskId, this.now());
    this.audit.write({
      event: 'inbound.message',
      peer: peer.peer_id,
      kind,
      trust,
      taskId,
      contextId,
      sessionId: result.sessionId,
      via: result.via,
      mode: result.mode,
      text,
    });
    return this.toTask(this.store.getTask(taskId)!);
  }

  private onGetTask(peer: PeerRow, id: string): Task {
    const t = this.store.getTask(id);
    if (!t || t.peer_id !== peer.peer_id || t.direction !== 'in') throw errors.taskNotFound(id);
    return this.toTask(t);
  }

  private onCancelTask(peer: PeerRow, id: string): Task {
    const t = this.store.getTask(id);
    if (!t || t.peer_id !== peer.peer_id || t.direction !== 'in') throw errors.taskNotFound(id);
    if (TERMINAL_STATES.has(t.state)) throw errors.taskNotCancelable(id);
    // TODO(P2): cancelling a live inbound task (request/notify) tells the owning
    // session and pushes CANCELED. Unreachable in P1: every inform task is terminal.
    this.store.updateTask(id, { state: 'TASK_STATE_CANCELED' }, this.now());
    this.audit.write({ event: 'task.state', peer: peer.peer_id, taskId: id, state: 'TASK_STATE_CANCELED' });
    return this.toTask(this.store.getTask(id)!);
  }

  private toTask(t: TaskRow): Task {
    let status: Task['status'] = { state: t.state };
    try {
      if (t.last_status_json) status = { ...JSON.parse(t.last_status_json), state: t.state };
    } catch {
      /* keep the bare state */
    }
    return { id: t.task_id, contextId: t.context_id ?? '', status };
  }

  // ---- outbound --------------------------------------------------------------

  private endpointFor(peer: PeerRow, withToken = true) {
    const token = withToken ? this.store.getOutboundToken(peer) : undefined;
    if (withToken && !token) throw new Error(`No stored token for ${peer.peer_id}. Re-pair with them.`);
    return { baseUrl: baseUrlOf(peer.card_url), certSha256: peer.cert_sha256, token: token ?? undefined };
  }

  /** Resolve a peer by handle or (case-insensitive) display name. */
  resolvePeer(ref: string): PeerRow {
    const q = String(ref ?? '').trim().toLowerCase().replace(/'s( agent)?$/, '').replace(/^@/, '');
    if (!q) throw new Error('Which peer? Give their handle (see A2APeers).');
    const peers = this.store.listPeers();
    const exact = peers.find((p) => p.peer_id === q);
    if (exact) return exact;
    const byName = peers.filter((p) => (p.display_name ?? '').toLowerCase() === q || (p.display_name ?? '').toLowerCase().split(/\s+/)[0] === q);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`"${ref}" matches several peers: ${byName.map((p) => p.peer_id).join(', ')}. Use the handle.`);
    const known = peers.map((p) => p.peer_id).join(', ') || 'none yet';
    throw new Error(`No paired peer called "${ref}". Paired peers: ${known}. To add one, pair with A2APair.`);
  }

  async send(args: {
    peer: string;
    text: string;
    toSession?: string;
    toProject?: string;
    contextId?: string;
    fromSessionLabel?: string;
    fromProject?: string;
  }): Promise<SendResult> {
    const peer = this.resolvePeer(args.peer);
    const text = String(args.text ?? '').trim();
    if (!text) throw new Error('Nothing to send: text is empty.');
    if (PAIRING_CODE_RE.test(text)) {
      throw new Error('Refusing to send an A2A pairing code inside a message. Pairing codes are secrets; give them to the person directly.');
    }
    if (peer.trust === 'blocked') throw new Error(`${peer.peer_id} is blocked. Change their trust first if you want to message them.`);
    const routing: RoutingInfo = {
      fromUser: this.opts.userName,
      fromAgent: this.agentKind,
      fromSessionLabel: args.fromSessionLabel,
      fromProject: args.fromProject,
      toSession: args.toSession,
      toProject: args.toProject,
    };
    for (const k of Object.keys(routing) as (keyof RoutingInfo)[]) if (!routing[k]) delete routing[k];
    const req: SendMessageRequest = {
      message: {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text }],
        ...(args.contextId ? { contextId: args.contextId } : {}),
        metadata: { kind: 'inform', [ROUTING_METADATA_KEY]: routing },
        extensions: [EXT_ROUTING],
      },
      configuration: { returnImmediately: true },
    };
    try {
      const res = await sendMessage(this.endpointFor(peer), req);
      const task = res.task;
      if (!task?.id) throw new Error('The peer answered without a task.');
      this.store.insertTask({
        taskId: task.id,
        peerId: peer.peer_id,
        direction: 'out',
        contextId: task.contextId ?? null,
        sessionId: null,
        kind: 'inform',
        state: task.status?.state ?? 'TASK_STATE_SUBMITTED',
        summary: text.slice(0, 200),
        requestJson: JSON.stringify(req.message),
        statusJson: JSON.stringify(task.status ?? null),
        now: this.now(),
      });
      this.store.touchPeer(peer.peer_id, this.now());
      this.audit.write({ event: 'outbound.message', peer: peer.peer_id, kind: 'inform', taskId: task.id, contextId: task.contextId, text });
      return { peer, taskId: task.id, contextId: task.contextId, state: task.status?.state ?? 'TASK_STATE_SUBMITTED' };
    } catch (e) {
      this.audit.write({ event: 'outbound.failed', peer: peer.peer_id, kind: 'inform', error: (e as Error).message });
      // TODO(P2): on PeerOfflineError write to a2a_outbox and retry for 24h (design 6.6).
      throw e;
    }
  }

  async peerStatuses(timeoutMs = 3000): Promise<PeerStatus[]> {
    const peers = this.store.listPeers();
    return Promise.all(
      peers.map(async (peer) => {
        if (peer.trust === 'blocked') return { peer, online: false };
        try {
          const card = await fetchExtendedCard(this.endpointFor(peer), timeoutMs);
          this.store.setPeerCard(peer.peer_id, JSON.stringify(card));
          this.store.touchPeer(peer.peer_id, this.now());
          return { peer, online: true, sessions: (card as Record<string, unknown>).sessions };
        } catch (e) {
          // A pin mismatch is not "offline": surface it so the user re-pairs.
          if (!(e instanceof PeerOfflineError) && (e as Error).name === 'CertPinMismatchError') throw e;
          return { peer, online: false };
        }
      })
    );
  }

  // ---- pairing -------------------------------------------------------------

  invite(): { code: string; expires: number } {
    const inv = createInvite(this.store, this.identity(), LIMITS.inviteTtlMs, this.now());
    this.audit.write({ event: 'pair.invite', inviteId: inv.inviteId, expires: inv.expires });
    return { code: inv.code, expires: inv.expires };
  }

  async redeem(code: string): Promise<PeerRow> {
    const peer = await redeemCode(this.store, code, this.identity(), this.now());
    this.audit.write({ event: 'pair.redeemed', peer: peer.peer_id, displayName: peer.display_name, cardUrl: peer.card_url });
    return peer;
  }

  revoke(peerRef: string): PeerRow {
    const peer = this.resolvePeer(peerRef);
    this.store.deletePeer(peer.peer_id);
    // TODO(P2): best-effort notify the peer (design 4.3 step 5). There is no
    // protocol route for it yet; for now their token simply stops working.
    this.audit.write({ event: 'peer.revoked', peer: peer.peer_id });
    return peer;
  }

  setTrust(peerRef: string, trust: TrustLevel): PeerRow {
    const peer = this.resolvePeer(peerRef);
    this.store.setTrust(peer.peer_id, trust, { now: this.now() });
    this.audit.write({ event: 'trust.changed', peer: peer.peer_id, from: peer.trust, to: trust });
    return this.store.getPeer(peer.peer_id)!;
  }
}
