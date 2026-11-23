/**
 * One A2A endpoint: server + client + store + router + push + waiters + audit,
 * wired together.
 *
 * This is the Electron-free core. `./index.ts` builds one for the app from
 * the real DB, secret storage and agent.ts; the tests build two of them in
 * one process against throwaway sql.js databases and talk real TLS between
 * them. Keeping the seam here is what lets the tests exercise the actual
 * server instead of a mock.
 *
 * Task lifecycle (design 5.2, 6.3), P2:
 *   inform           -> COMPLETED at once, delivered to a session.
 *   request / notify -> from collaborate / full: delivered, WORKING.
 *                       from inform: INPUT_REQUIRED "Waiting for <user> to
 *                       approve", held in the Agents panel inbox. Accept
 *                       delivers it (WORKING); Decline -> REJECTED.
 *   Every later state change, and every new agent message on the task, is
 *   pushed to the requester's registered URL (push.ts has the retry rules).
 *
 * Outbound tasks we create carry a per-task push token. We keep only its
 * SHA-256; an inbound push must present it AND come from the peer we created
 * the task on, and may only move the task forward (design 4.2.5).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { A2AProtocolError, errors } from './errors';
import { AuditLog } from './audit';
import { LIMITS } from './config';
import { createA2AServer, type A2AServer } from './server';
import { A2AStore, hashMatches, sha256Hex, type OutboxRow, type PeerRow, type SecretPort, type SqlHandle, type TaskRow } from './store';
import { deliver, deliverRouted, deliveryMode, gate, routeSession, type DeliveryResult, type InboundForRouting, type SessionPort } from './router';
import { acceptPair, createInvite, redeemCode, type LocalIdentity } from './pairing';
import {
  A2AClientError,
  baseUrlOf,
  cancelTask as clientCancelTask,
  fetchExtendedCard,
  getTask as clientGetTask,
  isRetryable,
  notifyUnpair,
  postPush,
  sendMessage,
  PeerOfflineError,
} from './client';
import {
  APPROVAL_METADATA_KEY,
  RETRY,
  isApprovalPendingStatus,
  isTaskState,
  judgeSnapshot,
  nextRetryTs,
  partsText,
  readStreamResponse,
  taskOutcomeText,
} from './push';
import { POLL_STALE_MS, Waiters, eventWakes, resumeNote, stateWord, type A2ATaskEvent, type WaitA2AState, type WaitPort } from './waiters';
import type { TlsIdentity } from './tls';
import type { EnvelopeDialect } from './envelope';
import {
  WatchRunner,
  WATCH_LIMITS,
  buildWatchState,
  decideTick,
  fmtDuration,
  maskSecrets,
  metArtifactParts,
  parseWatchState,
  wakeNote,
  type TickDecision,
  type WatchCheckFn,
  type WatchCheckResult,
  type WatchState,
} from './watch';
import {
  A2A_PROTOCOL_VERSION,
  EXT_PAIRING,
  EXT_ROUTING,
  EXT_WATCH,
  ROUTING_METADATA_KEY,
  WATCH_METADATA_KEY,
  TERMINAL_STATES,
  type AgentCard,
  type AgentKind,
  type Artifact,
  type ListTasksResponse,
  type Message,
  type MessageKind,
  type RoutingInfo,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  type TaskState,
  type TrustLevel,
  type WatchSuggestionInfo,
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
  /** Sessions sleeping in WaitForA2A (index.ts wires the DB + agent.ts). Optional in tests. */
  waits?: WaitPort;
  /**
   * A request / notify is waiting for the user's approval: desktop
   * notification, Agents-panel badge, Slack line (index.ts). Optional.
   */
  onApprovalNeeded?(task: TaskRow, peer: PeerRow, text: string): void;
  /** Anything the Agents panel shows changed. Optional. */
  onChange?(): void;
  /**
   * Every change on a task (push, poll, our own update), after the waiters
   * have seen it. The Claude Code daemon turns OUT-task updates into
   * `task_update` inbox items (design 7.3). Optional.
   */
  onTaskEvent?(ev: A2ATaskEvent): void;
  /**
   * Whose tool names the envelope's reply hint uses (envelope.ts). The
   * Claude Code daemon sets 'claude-code' so its sessions are told to use
   * a2a_reply / a2a_watch rather than Guy Code's A2AReply. Default Guy Code.
   */
  envelopeDialect?: EnvelopeDialect;
  /**
   * Run the outbox / push retry loop on a timer. On by default; tests switch
   * it off and call `flushOutbox()` themselves so timing is deterministic.
   */
  autoFlush?: boolean;
  /**
   * Runs a watch's check command (design 5.5). index.ts passes tools.ts's
   * `runConditionCheck`, the WaitForCondition runner, so watches use exactly
   * the same shell handling. Without it, A2AReply action=watch is refused.
   */
  watchCheck?: WatchCheckFn;
  /**
   * Arm in-process timers for watches, and sweep them on start. On by
   * default; tests switch it off and call `sweepWatches()` with a fake clock.
   */
  autoWatch?: boolean;
}

export interface WatchArgs {
  taskId: string;
  command: unknown;
  shell?: unknown;
  intervalMs?: unknown;
  timeoutMs?: unknown;
  onMet?: unknown;
  /** Optional status line for the requester; defaults to "Watching: <command> ...". */
  text?: string;
}

export interface WatchResult {
  task: TaskRow;
  watch: WatchState;
  /** 'watching' = installed; 'met' = the first check already passed. */
  outcome: 'watching' | 'met';
}

export interface SendResult {
  peer: PeerRow;
  taskId: string;
  contextId: string;
  state: TaskState;
  /** True when the peer was offline and the message went to the outbox. */
  queued?: boolean;
  queuedUntil?: number;
}

export interface PeerStatus {
  peer: PeerRow;
  online: boolean;
  sessions?: unknown;
}

export interface ReplyArgs {
  taskId: string;
  action: 'message' | 'working' | 'needs_input' | 'complete' | 'fail' | 'reject' | 'watch';
  text?: string;
  data?: unknown;
}

const VALID_KINDS: readonly MessageKind[] = ['inform', 'request', 'notify'];

/** Pairing codes are secrets (design 4.2.3 item 5): never let one leave in a message body. */
const PAIRING_CODE_RE = /a2a1:[A-Za-z0-9_-]{20,}/;

const OUTBOX_TICK_MS = 2_000;

function shortId(id: string): string {
  return id.slice(0, 8);
}

export class A2ANode {
  readonly store: A2AStore;
  readonly audit: AuditLog;
  readonly waiters: Waiters;
  private server: A2AServer | null = null;
  private readonly now: () => number;
  private readonly agentKind: AgentKind;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  readonly watches: WatchRunner;
  /** Task whose first watch check is running inside the A2AReply call (see notifyOwner). */
  private inlineWatch: string | null = null;

  constructor(private readonly opts: A2ANodeOptions) {
    this.store = new A2AStore(opts.sql, opts.secrets);
    this.audit = new AuditLog(opts.auditPath);
    this.now = opts.now ?? Date.now;
    this.agentKind = opts.agentKind ?? 'guycode';
    this.waiters = new Waiters(opts.waits);
    this.watches = new WatchRunner(
      {
        list: () =>
          this.store.listWatchedTasks().flatMap((t) => {
            const s = parseWatchState(t.watch_json);
            if (!s) {
              this.store.endWatch(t.task_id);
              return [];
            }
            return [{ taskId: t.task_id, state: s, nextTs: t.watch_next_ts ?? 0 }];
          }),
        get: (id) => {
          const t = this.store.getTask(id);
          const s = t && t.watch_next_ts != null && !TERMINAL_STATES.has(t.state) ? parseWatchState(t.watch_json) : null;
          return s ? { state: s, nextTs: t!.watch_next_ts! } : null;
        },
        check: (command, cwd, shell, timeoutMs) => {
          if (!this.opts.watchCheck) return Promise.resolve({ code: 125, launched: false, detail: 'no watch runner in this build' });
          return this.opts.watchCheck(command, cwd, shell, timeoutMs);
        },
        apply: (id, ran, d, r) => this.applyWatchTick(id, ran, d, r),
        now: () => this.now(),
      },
      { timers: opts.autoWatch !== false }
    );
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
        listTasks: (p, q) => this.onListTasks(p, q),
        push: (p, body, tok) => this.onPush(p, body, tok),
        unpaired: (p) => this.onUnpaired(p),
        onPeerSeen: (p) => this.onPeerSeen(p),
        pair: async (req, remote) => {
          try {
            const { response, peer } = await acceptPair(this.store, req, this.identity(), {
              allowHttp: !!this.opts.insecureHttp,
              now: this.now(),
              verifyPeerCard: this.opts.verifyPeerCardOnPair,
            });
            this.audit.write({ event: 'pair.accepted', peer: peer.peer_id, displayName: peer.display_name, cardUrl: peer.card_url, remote });
            this.changed();
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
    if (this.opts.autoFlush !== false) {
      this.flushTimer = setInterval(() => void this.flushOutbox().catch(() => {}), OUTBOX_TICK_MS);
      this.flushTimer.unref?.();
    }
    // Watches survive a restart: run whatever fell due while we were down and
    // re-arm the rest (design 5.5, the same idea as the governor sweep for
    // WaitForCondition).
    this.watches.start();
    if (this.opts.autoWatch !== false) void this.sweepWatches().catch(() => {});
  }

  async stop(): Promise<void> {
    this.watches.stopAll();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
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
    return {
      cardUrl: this.cardUrl(),
      certSha256: this.fingerprint(),
      certPem: this.opts.tls?.certPem,
      displayName: this.opts.displayName,
      agentKind: this.agentKind,
    };
  }

  private changed(): void {
    try {
      this.opts.onChange?.();
    } catch {
      /* UI refresh is a nicety */
    }
  }

  // ---- cards ---------------------------------------------------------------

  card(): AgentCard {
    const who = this.opts.displayName;
    const cc = this.agentKind === 'claude-code';
    return {
      name: `${who}'s agents`,
      description: `${cc ? 'Claude Code' : 'Guy Code'} agents for ${who}. Coordination only; pair first.`,
      // Our HTTP+JSON routes live at the origin root, so that is the interface URL.
      supportedInterfaces: [{ url: this.origin(), protocolBinding: 'HTTP+JSON', protocolVersion: A2A_PROTOCOL_VERSION }],
      version: `${cc ? 'a2a-peer' : 'guycode'}-${this.opts.appVersion ?? 'dev'}`,
      capabilities: {
        streaming: false,
        pushNotifications: true,
        extendedAgentCard: true,
        extensions: [
          { uri: EXT_ROUTING, required: false, description: 'Target a specific session/project; carry sender session label.' },
          { uri: EXT_PAIRING, required: false, description: 'Pairing handshake at /a2a-pair.' },
          {
            uri: EXT_WATCH,
            required: false,
            description:
              'Notify tasks can be completed by a check this agent writes and its runtime polls with no AI. ' +
              `You may suggest a check in metadata["${WATCH_METADATA_KEY}"].suggestion; it is shown as text and never run as given.`,
          },
        ],
      },
      securitySchemes: { peerBearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { peerBearer: { list: [] } } }],
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [
        { id: 'inform', name: 'Inform', description: "Tell this user's agent something.", tags: ['fyi'] },
        { id: 'request', name: 'Request', description: "Ask this user's agent a question or to do something (subject to trust).", tags: ['ask'] },
        { id: 'notify', name: 'Notify when', description: 'Ask to be notified when something finishes or becomes true.', tags: ['watch'] },
      ],
    };
  }

  extendedCard(_peer: PeerRow): AgentCard & Record<string, unknown> {
    // Sessions stay unexposed: design 5.1 makes exposure per session and off
    // by default, and the "a2a.exposeSessions" control has no UI yet. Peers
    // still reach the right place through toProject / toSession by name.
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
      this.changed();
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

  /**
   * Validate the requester's push config. Its origin must be the peer's own
   * pinned endpoint: we only ever dial a peer through `connectPinned` with
   * the cert we paired with, so a config pointing anywhere else could not be
   * delivered safely (and would let one peer aim our pushes at a third host).
   */
  private acceptPushConfig(peer: PeerRow, req: SendMessageRequest): { path: string; token: string | null } | null {
    const cfg = req.configuration?.taskPushNotificationConfig;
    if (!cfg) return null;
    if (typeof cfg !== 'object' || typeof cfg.url !== 'string') throw errors.badRequest('taskPushNotificationConfig.url is required.');
    let u: URL;
    try {
      u = new URL(cfg.url);
    } catch {
      throw errors.badRequest('taskPushNotificationConfig.url is not a URL.');
    }
    if (`${u.protocol}//${u.host}` !== baseUrlOf(peer.card_url)) {
      throw errors.badRequest('taskPushNotificationConfig.url must be on your own paired endpoint.');
    }
    if (cfg.token !== undefined && (typeof cfg.token !== 'string' || cfg.token.length > 512)) {
      throw errors.badRequest('taskPushNotificationConfig.token must be a string.');
    }
    return { path: u.pathname + u.search, token: cfg.token ?? null };
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
    let kind: MessageKind = (VALID_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as MessageKind) : 'inform';

    let existing: TaskRow | undefined;
    if (msg.taskId) {
      // A follow-up on a live task (the requester adds detail, or answers our
      // INPUT_REQUIRED). It goes to the session that owns the task.
      const t = this.store.getTask(msg.taskId);
      if (!t || t.peer_id !== peer.peer_id || t.direction !== 'in') throw errors.taskNotFound(msg.taskId);
      if (TERMINAL_STATES.has(t.state)) throw errors.unsupportedOperation(`Task ${msg.taskId} is already finished; send a new message instead.`);
      if (msg.contextId && t.context_id && msg.contextId !== t.context_id) throw errors.badRequest('contextId does not match the task.');
      existing = t;
      kind = (t.kind as MessageKind) || kind;
    }

    // contextId: reuse the peer's, but never let one peer write into another
    // peer's conversation.
    let contextId = existing?.context_id || msg.contextId || '';
    let mappedSessionId: string | null = null;
    if (contextId) {
      const ctx = this.store.getContext(contextId);
      if (ctx && ctx.peer_id !== peer.peer_id) throw errors.badRequest('contextId belongs to a different conversation.');
      mappedSessionId = ctx?.session_id ?? null;
    } else {
      contextId = randomUUID();
    }
    if (existing?.session_id) mappedSessionId = existing.session_id;

    const routingRaw = meta[ROUTING_METADATA_KEY];
    const routing: RoutingInfo = routingRaw && typeof routingRaw === 'object' && !Array.isArray(routingRaw) ? (routingRaw as RoutingInfo) : {};
    const text = inboundText(msg, this.opts.envelopeDialect);
    const push = kind === 'inform' ? null : this.acceptPushConfig(peer, req);

    const decision = gate(kind, trust); // throws for blocked
    const routed: Omit<InboundForRouting, 'taskId'> = {
      peer,
      trust,
      kind,
      contextId,
      text,
      routing,
      mappedSessionId,
      urgent: meta.urgent === true,
      fullGrantedTs: peer.trust_granted_ts,
      fullExpiresTs: peer.trust_expires_ts,
      dialect: this.opts.envelopeDialect,
    };

    if (existing) return this.onFollowUp(peer, existing, msg, routed);

    if (kind !== 'inform' && this.store.countTasks({ direction: 'in', peerId: peer.peer_id, open: true }) >= LIMITS.maxOpenTasksPerPeer) {
      throw errors.tooManyTasks(LIMITS.maxOpenTasksPerPeer);
    }

    const taskId = randomUUID();
    const nowIso = new Date(this.now()).toISOString();

    if (decision === 'approve') {
      // Held for the local user (design 6.3 step 4): nothing reaches a session
      // until Accept. We still pick the session now so the inbox can say
      // where it will go.
      const { session } = routeSession(this.opts.sessions, routed);
      const status = {
        state: 'TASK_STATE_INPUT_REQUIRED' as TaskState,
        message: this.agentMessage(taskId, contextId, `Waiting for ${this.opts.displayName} to approve.`, { [APPROVAL_METADATA_KEY]: 'pending' }),
        timestamp: nowIso,
      };
      this.store.insertTask({
        taskId,
        peerId: peer.peer_id,
        direction: 'in',
        contextId,
        sessionId: session.id,
        kind,
        state: status.state,
        summary: text.slice(0, 200),
        requestJson: JSON.stringify(msg),
        statusJson: JSON.stringify(status),
        approval: 'pending',
        now: this.now(),
      });
      if (push) this.store.savePushConfig(taskId, push.path, push.token);
      this.store.recordSeenMessage(peer.peer_id, msg.messageId, taskId, this.now());
      this.audit.write({ event: 'inbound.message', peer: peer.peer_id, kind, trust, taskId, contextId, held: 'approval', text });
      this.audit.write({ event: 'task.approval', peer: peer.peer_id, taskId, approval: 'pending', sessionId: session.id });
      const row = this.store.getTask(taskId)!;
      try {
        this.opts.onApprovalNeeded?.(row, peer, text);
      } catch {
        /* notifications are a nicety */
      }
      this.changed();
      return this.toTask(row);
    }

    let result: DeliveryResult;
    try {
      result = deliver(this.opts.sessions, { ...routed, taskId });
    } catch (e) {
      this.audit.write({ event: 'inbound.rejected', peer: peer.peer_id, kind, reason: (e as A2AProtocolError).reason ?? String(e) });
      throw e;
    }

    // Inform tasks complete immediately (design 5.2): there is no lifecycle,
    // the message has been handed to a session. A delivered request / notify
    // is WORKING until the session answers with A2AReply.
    const state: TaskState = kind === 'inform' ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING';
    const status = { state, timestamp: nowIso };
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
    if (push) this.store.savePushConfig(taskId, push.path, push.token);
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
    this.changed();
    return this.toTask(this.store.getTask(taskId)!);
  }

  /** A message on a task that already exists (and is ours to answer). */
  private onFollowUp(peer: PeerRow, t: TaskRow, msg: Message, routed: Omit<InboundForRouting, 'taskId'>): Task {
    this.store.recordSeenMessage(peer.peer_id, msg.messageId, t.task_id, this.now());
    this.audit.write({ event: 'inbound.message', peer: peer.peer_id, kind: t.kind, trust: routed.trust, taskId: t.task_id, contextId: t.context_id, followUp: true, text: routed.text });
    if (t.approval === 'pending') {
      // Still unapproved: fold the extra text into what the user will see on Accept.
      try {
        const orig = JSON.parse(t.request_json ?? '{}') as Message;
        orig.parts = [...(orig.parts ?? []), { text: `(follow-up) ${routed.text}` }].slice(0, LIMITS.maxParts);
        this.opts.sql.prepare('UPDATE a2a_tasks SET request_json = ? WHERE task_id = ?').run(JSON.stringify(orig), t.task_id);
      } catch {
        /* keep the original */
      }
      this.changed();
      return this.toTask(this.store.getTask(t.task_id)!);
    }
    const rows = this.opts.sessions.listSessions().filter((s) => s.archived === 0);
    const owner = rows.find((s) => s.id === t.session_id);
    const { session, via } = owner ? { session: owner, via: 'context' as const } : routeSession(this.opts.sessions, routed);
    deliverRouted(this.opts.sessions, session, via, { ...routed, taskId: t.task_id, contextId: t.context_id ?? routed.contextId });
    // The requester answered our question: back to WORKING.
    if (t.state === 'TASK_STATE_INPUT_REQUIRED') this.setInboundState(t, 'TASK_STATE_WORKING', 'Got your answer; working on it.');
    this.changed();
    return this.toTask(this.store.getTask(t.task_id)!);
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
    this.setInboundState(t, 'TASK_STATE_CANCELED', `Cancelled by ${peer.display_name || peer.peer_id}.`, { push: false });
    if (t.approval === 'pending') this.store.patchTask(id, { approval: 'cancelled' }, this.now());
    // Tell the session that was working on it, so it stops.
    if (t.session_id && t.approval !== 'pending') {
      const s = this.opts.sessions.listSessions().find((r) => r.id === t.session_id && r.archived === 0);
      if (s) {
        const note = `[A2A] ${peer.peer_id}'s agent cancelled task ${shortId(id)}${t.summary ? ` ("${t.summary.slice(0, 80)}")` : ''}. Stop working on it; no reply is needed.`;
        // Running: it sees this between tool rounds. Otherwise it is picked up
        // at the start of the session's next turn; a cancel is not worth
        // waking (and paying for) a session just to say "stop".
        this.opts.sessions.queueInterrupt(s.id, note);
      }
    }
    this.changed();
    return this.toTask(this.store.getTask(id)!);
  }

  /** GET /tasks: only the tasks this peer sent us. It never sees our tasks with anyone else. */
  private onListTasks(peer: PeerRow, q: URLSearchParams): ListTasksResponse {
    const pageSize = Math.max(1, Math.min(Number(q.get('pageSize')) || 50, 100));
    const offset = Math.max(0, Number(q.get('pageToken')) || 0);
    const contextId = q.get('contextId') || undefined;
    const stateRaw = q.get('status') || q.get('state') || undefined;
    const state = stateRaw && isTaskState(stateRaw) ? stateRaw : undefined;
    const filter = { direction: 'in' as const, peerId: peer.peer_id, contextId, state };
    const rows = this.store.listTasks({ ...filter, limit: pageSize, offset });
    const total = this.store.countTasks(filter);
    const next = offset + rows.length < total ? String(offset + rows.length) : '';
    return { tasks: rows.map((r) => this.toTask(r)), nextPageToken: next, pageSize, totalSize: total };
  }

  private onUnpaired(peer: PeerRow): void {
    // They deleted us. Our token for them is dead, and theirs for us must be
    // too: drop the pairing rather than keep a half-working one.
    this.stopPeerWatches(peer.peer_id, 'peer unpaired');
    this.store.deletePeer(peer.peer_id);
    this.audit.write({ event: 'peer.unpaired_by_remote', peer: peer.peer_id });
    this.opts.sessions.notify?.('A2A peer unpaired', `${peer.display_name || peer.peer_id} unpaired from your agent.`);
    this.changed();
  }

  private onPeerSeen(peer: PeerRow): void {
    // They are reachable now: anything queued for them is due immediately.
    if (this.store.expediteOutbox(peer.peer_id, this.now()) > 0) this.kickFlush();
  }

  /** Try the outbox soon (next tick), unless the owner drives it by hand (tests). */
  private kickFlush(): void {
    if (this.opts.autoFlush === false || !this.server) return;
    setTimeout(() => void this.flushOutbox().catch(() => {}), 0).unref?.();
  }

  // ---- approval (design 6.3 step 4) ------------------------------------------

  pendingApprovals(): TaskRow[] {
    return this.store.listTasks({ direction: 'in', approval: 'pending', open: true });
  }

  /** Resolve a task by id or 8-char prefix. */
  resolveTask(ref: string, direction?: 'in' | 'out'): TaskRow {
    const id = String(ref ?? '').trim();
    if (!id) throw new Error('Which task? Give its id (see A2ATasks).');
    const exact = this.store.getTask(id);
    if (exact && (!direction || exact.direction === direction)) return exact;
    const hits = this.store.findTasksByPrefix(id, direction);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${id}" matches several tasks: ${hits.map((t) => shortId(t.task_id)).join(', ')}. Use more of the id.`);
    throw new Error(`No ${direction === 'in' ? 'inbound ' : direction === 'out' ? 'outbound ' : ''}A2A task "${id}".`);
  }

  /**
   * The user accepted a held request: deliver it now (to `sessionId` if they
   * chose one, else where it was routed) and move the task to WORKING.
   */
  accept(ref: string, opts: { sessionId?: string; by?: string } = {}): { task: TaskRow; delivery: DeliveryResult } {
    const t = this.resolveTask(ref, 'in');
    if (t.approval !== 'pending' || TERMINAL_STATES.has(t.state)) throw new Error(`Task ${shortId(t.task_id)} is not waiting for approval.`);
    const peer = this.store.getPeer(t.peer_id);
    if (!peer) throw new Error(`The peer for task ${shortId(t.task_id)} is no longer paired.`);
    const msg = JSON.parse(t.request_json ?? '{}') as Message;
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    const routingRaw = meta[ROUTING_METADATA_KEY];
    const routing: RoutingInfo = routingRaw && typeof routingRaw === 'object' ? (routingRaw as RoutingInfo) : {};
    const text = inboundText(msg, this.opts.envelopeDialect);
    // The user approved THIS request, so deliver it at the peer's trust (the
    // envelope still says what the trust is); approving does not escalate.
    const trust = this.effectiveTrust(peer);
    const routed: InboundForRouting = {
      peer,
      trust: trust === 'blocked' ? 'inform' : trust,
      kind: (t.kind as MessageKind) || 'request',
      contextId: t.context_id ?? randomUUID(),
      taskId: t.task_id,
      text,
      routing,
      mappedSessionId: opts.sessionId ?? t.session_id,
      fullGrantedTs: peer.trust_granted_ts,
      fullExpiresTs: peer.trust_expires_ts,
      dialect: this.opts.envelopeDialect,
    };
    const rows = this.opts.sessions.listSessions().filter((s) => s.archived === 0);
    const chosen = opts.sessionId ? rows.find((s) => s.id === opts.sessionId) : undefined;
    if (opts.sessionId && !chosen) throw new Error('That session no longer exists.');
    const { session, via } = chosen ? { session: chosen, via: 'context' as const } : routeSession(this.opts.sessions, routed);
    const delivery = deliverRouted(this.opts.sessions, session, via, routed);
    this.store.patchTask(t.task_id, { approval: 'accepted', sessionId: session.id }, this.now());
    if (routed.contextId) this.store.setContext(routed.contextId, peer.peer_id, session.id, this.now());
    this.audit.write({ event: 'task.approval', peer: peer.peer_id, taskId: t.task_id, approval: 'accepted', by: opts.by ?? 'user', sessionId: session.id, mode: delivery.mode });
    this.setInboundState(this.store.getTask(t.task_id)!, 'TASK_STATE_WORKING', `${this.opts.displayName} approved; working on it.`);
    this.changed();
    return { task: this.store.getTask(t.task_id)!, delivery };
  }

  /** The user declined a held request: REJECTED, pushed to the requester. */
  decline(ref: string, opts: { reason?: string; by?: string } = {}): TaskRow {
    const t = this.resolveTask(ref, 'in');
    if (t.approval !== 'pending' || TERMINAL_STATES.has(t.state)) throw new Error(`Task ${shortId(t.task_id)} is not waiting for approval.`);
    this.store.patchTask(t.task_id, { approval: 'declined' }, this.now());
    this.audit.write({ event: 'task.approval', peer: t.peer_id, taskId: t.task_id, approval: 'declined', by: opts.by ?? 'user' });
    const why = opts.reason?.trim() ? `${this.opts.displayName} declined: ${opts.reason.trim()}` : `${this.opts.displayName} declined this request.`;
    this.setInboundState(this.store.getTask(t.task_id)!, 'TASK_STATE_REJECTED', why);
    this.changed();
    return this.store.getTask(t.task_id)!;
  }

  // ---- answering inbound tasks (A2AReply) --------------------------------------

  reply(args: ReplyArgs, ctx: { sessionId?: string } = {}): TaskRow {
    const t = this.resolveTask(args.taskId, 'in');
    if (args.action === 'watch') {
      // Installing a watch is async (it runs the first check), so it has its
      // own entry point; A2AReply routes action=watch to `watch()`.
      throw new Error('action "watch" goes through A2ANode.watch() (it needs a command, and runs the first check).');
    }
    if (TERMINAL_STATES.has(t.state)) throw new Error(`Task ${shortId(t.task_id)} is already ${stateWord(t.state)}; it cannot change any more.`);
    if (t.approval === 'pending') throw new Error(`Task ${shortId(t.task_id)} is still waiting for your user to approve it in the Agents panel; it cannot be answered until then.`);
    const text = String(args.text ?? '').trim();
    if (PAIRING_CODE_RE.test(text)) throw new Error('Refusing to send an A2A pairing code to another agent. Pairing codes are secrets.');
    const parts = this.replyParts(text, args.data);
    if (ctx.sessionId && t.session_id !== ctx.sessionId) {
      // Any session may answer (the user may have moved it), but record who did.
      this.store.patchTask(t.task_id, { sessionId: ctx.sessionId }, this.now());
    }
    this.audit.write({ event: 'task.reply', peer: t.peer_id, taskId: t.task_id, action: args.action, sessionId: ctx.sessionId, text });
    if (args.action === 'message') {
      if (!parts.length) throw new Error('Nothing to send: give text or data.');
      const m = this.agentMessage(t.task_id, t.context_id ?? '', '', undefined, parts);
      this.queuePush(t, { message: m });
      this.changed();
      return this.store.getTask(t.task_id)!;
    }
    const map: Record<string, TaskState> = {
      working: 'TASK_STATE_WORKING',
      needs_input: 'TASK_STATE_INPUT_REQUIRED',
      complete: 'TASK_STATE_COMPLETED',
      fail: 'TASK_STATE_FAILED',
      reject: 'TASK_STATE_REJECTED',
    };
    const state = map[args.action];
    if (!state) throw new Error('action must be message, working, needs_input, complete, fail, reject or watch.');
    if ((state === 'TASK_STATE_COMPLETED' || state === 'TASK_STATE_INPUT_REQUIRED') && !parts.length) {
      throw new Error(state === 'TASK_STATE_COMPLETED' ? 'Give the answer or outcome in text (or data) when completing.' : 'Say what you need from them in text.');
    }
    const artifacts: Artifact[] | undefined =
      state === 'TASK_STATE_COMPLETED' ? [{ artifactId: randomUUID(), name: t.kind === 'notify' ? 'outcome' : 'answer', parts }] : undefined;
    this.setInboundState(t, state, state === 'TASK_STATE_COMPLETED' ? '' : text, { artifacts, parts: state === 'TASK_STATE_COMPLETED' ? undefined : parts });
    this.changed();
    return this.store.getTask(t.task_id)!;
  }

  private replyParts(text: string, data: unknown): Array<{ text?: string; data?: unknown }> {
    const parts: Array<{ text?: string; data?: unknown }> = [];
    if (text) parts.push({ text });
    if (data !== undefined && data !== null) parts.push({ data });
    if (JSON.stringify(parts).length > LIMITS.maxBodyBytes / 2) throw new Error('Reply is too large; share a path or link instead.');
    return parts;
  }

  private agentMessage(taskId: string, contextId: string, text: string, metadata?: Record<string, unknown>, parts?: Array<{ text?: string; data?: unknown }>): Message {
    return {
      messageId: randomUUID(),
      role: 'ROLE_AGENT',
      taskId,
      contextId,
      parts: parts ?? [{ text }],
      ...(metadata ? { metadata } : {}),
    };
  }

  /** Change an IN task's state, record it, and push it to the requester. */
  private setInboundState(
    t: TaskRow,
    state: TaskState,
    statusText: string,
    o: { push?: boolean; artifacts?: Artifact[]; parts?: Array<{ text?: string; data?: unknown }> } = {}
  ): void {
    if (TERMINAL_STATES.has(t.state)) return; // a terminal task never changes again
    const status: Task['status'] = { state, timestamp: new Date(this.now()).toISOString() };
    if (o.parts?.length || statusText) status.message = this.agentMessage(t.task_id, t.context_id ?? '', statusText, undefined, o.parts?.length ? o.parts : undefined);
    const prevArtifacts: Artifact[] = t.artifacts_json ? safeJson<Artifact[]>(t.artifacts_json) ?? [] : [];
    const artifacts = o.artifacts ? [...prevArtifacts, ...o.artifacts] : undefined;
    this.store.patchTask(
      t.task_id,
      { state, statusJson: JSON.stringify(status), ...(artifacts ? { artifactsJson: JSON.stringify(artifacts) } : {}) },
      this.now()
    );
    this.audit.write({ event: 'task.state', peer: t.peer_id, taskId: t.task_id, direction: 'in', from: t.state, state });
    // A finished task (completed, failed, rejected, or cancelled by either
    // side) has nothing left to watch: stop the check for good.
    if (TERMINAL_STATES.has(state)) this.stopWatch(t, `task ${stateWord(state)}`);
    if (o.push !== false) this.queuePush(this.store.getTask(t.task_id)!, { task: this.toTask(this.store.getTask(t.task_id)!) });
  }

  // ---- watch extension (design 5.5) --------------------------------------------

  /**
   * A2AReply action=watch. Installs a check command on an accepted inbound
   * notify task. Every input here comes from the LOCAL agent's tool call;
   * nothing is read from the requester's message (see watch.ts SECURITY).
   * The first check runs at once: a command that cannot launch is refused
   * with nothing changed, and an event that has already happened completes
   * the task straight away (or, for onMet "wake", tells the calling agent to
   * summarise in the tool result).
   */
  async watch(args: WatchArgs, ctx: { sessionId?: string; cwd?: string } = {}): Promise<WatchResult> {
    const t = this.resolveTask(args.taskId, 'in');
    if (TERMINAL_STATES.has(t.state)) throw new Error(`Task ${shortId(t.task_id)} is already ${stateWord(t.state)}; there is nothing left to watch.`);
    if (t.approval === 'pending') throw new Error(`Task ${shortId(t.task_id)} is still waiting for your user to approve it in the Agents panel; it cannot be watched until then.`);
    if (!this.opts.watchCheck) throw new Error('Watching is not available here (no condition runner). Reply "working" now and "complete" when it happens.');
    const state = buildWatchState(
      {
        command: args.command,
        shell: args.shell,
        intervalMs: args.intervalMs,
        timeoutMs: args.timeoutMs,
        onMet: args.onMet,
        cwd: ctx.cwd ?? '',
        sessionId: ctx.sessionId ?? t.session_id ?? null,
      },
      this.now(),
      randomUUID()
    );
    const extra = String(args.text ?? '').trim();
    if (PAIRING_CODE_RE.test(extra) || PAIRING_CODE_RE.test(state.command)) throw new Error('Refusing to send an A2A pairing code to another agent. Pairing codes are secrets.');

    // First check now, before anything is stored or sent. As with
    // WaitForCondition, a check that cannot even launch is refused here
    // rather than turned into a watch that loops on a broken command.
    let first: WatchCheckResult;
    try {
      first = await this.opts.watchCheck(state.command, state.cwd, state.shell, WATCH_LIMITS.checkTimeoutMs);
    } catch (e) {
      first = { code: 125, launched: false, detail: (e as Error).message };
    }
    if (!first.launched) {
      throw new Error(`The check command could not run (${first.detail ?? `exit ${first.code}`}). Nothing was changed. Fix the command or the shell and try again (on Windows, bash runs through WSL).`);
    }
    // The task may have changed while the check ran (cancelled, answered).
    const cur = this.store.getTask(t.task_id)!;
    if (TERMINAL_STATES.has(cur.state)) throw new Error(`Task ${shortId(t.task_id)} became ${stateWord(cur.state)} while the first check ran; nothing to watch.`);

    if (ctx.sessionId && cur.session_id !== ctx.sessionId) this.store.patchTask(t.task_id, { sessionId: ctx.sessionId }, this.now());
    const replaced = parseWatchState(cur.watch_json);
    if (replaced && cur.watch_next_ts != null) this.watches.cancel(t.task_id);
    // Store it as due now: if we crash before the first result is applied,
    // the sweep after restart simply checks again.
    this.store.setWatch(t.task_id, JSON.stringify(state), this.now(), this.now());
    this.audit.write({
      event: 'watch.started',
      peer: t.peer_id,
      taskId: t.task_id,
      sessionId: state.sessionId,
      command: maskSecrets(state.command),
      shell: state.shell,
      intervalMs: state.intervalMs,
      deadline: state.deadlineTs,
      onMet: state.onMet,
      replaced: replaced ? replaced.id : undefined,
    });
    const every = fmtDuration(state.intervalMs);
    const forUpTo = fmtDuration(state.deadlineTs - state.startedTs);
    const statusText = extra || `Watching: \`${maskSecrets(state.command)}\` (checked every ${every} for up to ${forUpTo}; you will be told when it is true).`;
    const fresh = this.store.getTask(t.task_id)!;
    const metNow = first.code === 0;
    if (!(metNow && state.onMet === 'complete')) {
      // A WORKING status (a fresh snapshot even when it was WORKING already),
      // NOT an agent message: the requester's default WaitForA2A wakes on a
      // new message but sleeps through WORKING, and "I am watching" is
      // exactly the kind of update that must not cost them a model call.
      // When the check already passes with onMet "complete" this is skipped:
      // the task completes just below.
      this.setInboundState(fresh, 'TASK_STATE_WORKING', statusText);
    }
    this.changed();
    this.inlineWatch = t.task_id;
    try {
      this.applyWatchTick(t.task_id, state, decideTick(state, first, this.now()), first);
    } finally {
      this.inlineWatch = null;
    }
    const after = this.store.getTask(t.task_id)!;
    if (after.watch_next_ts != null) this.watches.arm(t.task_id, after.watch_next_ts);
    return { task: after, watch: parseWatchState(after.watch_json) ?? state, outcome: metNow ? 'met' : 'watching' };
  }

  /** Run every due watch and arm the rest. The governor sweep and node start call this. */
  sweepWatches(): Promise<void> {
    return this.watches.sweep();
  }

  /** Stop a task's watch (if live), audit it, and keep the JSON as a record. */
  private stopWatch(t: TaskRow, reason: string): void {
    if (t.watch_next_ts == null) return;
    this.watches.cancel(t.task_id);
    this.store.endWatch(t.task_id);
    this.audit.write({ event: 'watch.stopped', peer: t.peer_id, taskId: t.task_id, reason });
  }

  /**
   * Apply one check's result. Discards it when the watch it ran for was
   * replaced, stopped, or the task finished while the check was running.
   */
  private applyWatchTick(taskId: string, ran: WatchState, d: TickDecision, r: WatchCheckResult): boolean {
    const t = this.store.getTask(taskId);
    const cur = t ? parseWatchState(t.watch_json) : null;
    if (!t || !cur || cur.id !== ran.id || t.watch_next_ts == null || TERMINAL_STATES.has(t.state)) return false;
    const now = this.now();
    // Not every check: a 1-minute check for 30 days would be 43,000 lines of
    // "not yet". Only the ones that could not run (the user may need to fix
    // the command); met, timeout and broken have their own events below.
    if (!r.launched) this.audit.write({ event: 'watch.check', peer: t.peer_id, taskId, exitCode: r.code, launched: false, result: d.kind, detail: r.detail });
    if (d.kind === 'again') {
      this.store.setWatch(taskId, JSON.stringify(d.state), d.nextTs, now);
      return true;
    }
    if (d.kind === 'timeout' || d.kind === 'broken') {
      this.store.setWatch(taskId, JSON.stringify(d.state), null, now);
      this.audit.write({ event: 'watch.stopped', peer: t.peer_id, taskId, reason: d.kind, detail: d.reason });
      this.setInboundState(this.store.getTask(taskId)!, 'TASK_STATE_FAILED', d.reason);
      this.notifyOwner(t, d.state, `[A2A watch] ${d.reason} ${t.peer_id}'s task ${shortId(taskId)} is now FAILED and their agent has been told.`);
      this.changed();
      return true;
    }
    // Met.
    this.store.setWatch(taskId, JSON.stringify(d.state), null, now);
    this.audit.write({ event: 'watch.met', peer: t.peer_id, taskId, onMet: d.state.onMet, exitCode: r.code, checks: d.state.checks });
    if (d.state.onMet === 'complete') {
      // No model call at all (design 5.5): the runtime writes the outcome.
      const parts = metArtifactParts(d.state, r, now);
      this.setInboundState(this.store.getTask(taskId)!, 'TASK_STATE_COMPLETED', '', {
        artifacts: [{ artifactId: randomUUID(), name: 'outcome', parts, metadata: { [WATCH_METADATA_KEY]: { onMet: 'complete' } } }],
      });
      this.notifyOwner(t, d.state, `[A2A watch] ${t.peer_id}'s task ${shortId(taskId)} is done: the check exited 0, so it was completed and their agent was told. No reply is needed.`);
    } else {
      this.wakeOwner(t, d.state, r);
    }
    this.changed();
    return true;
  }

  /** onMet "wake": hand the owning session a note so the agent writes the summary and completes the task. */
  private wakeOwner(t: TaskRow, s: WatchState, r: WatchCheckResult): void {
    const note = wakeNote(s, r, { taskId: t.task_id, peerId: t.peer_id, summary: t.summary });
    const session = this.ownerSession(t, s);
    if (!session) {
      // Nobody to wake (the session was archived): do not leave the
      // requester hanging; complete it the no-AI way instead.
      const parts = metArtifactParts(s, r, this.now());
      this.setInboundState(this.store.getTask(t.task_id)!, 'TASK_STATE_COMPLETED', '', { artifacts: [{ artifactId: randomUUID(), name: 'outcome', parts }] });
      this.audit.write({ event: 'watch.met', peer: t.peer_id, taskId: t.task_id, fallback: 'complete', reason: 'owning session gone' });
      return;
    }
    if (this.inlineWatch === t.task_id) {
      // Met on the very first check, inside the agent's own A2AReply call:
      // the tool result tells it to summarise, so no extra turn is needed.
      this.audit.write({ event: 'watch.woke', peer: t.peer_id, taskId: t.task_id, sessionId: session.id, mode: 'inline' });
      return;
    }
    // Same rules as an inbound message (router.deliveryMode): a running turn
    // sees it between tool rounds; an idle session starts a turn; a session
    // sleeping in some OTHER wait (WaitForTime, WaitForCondition, budget) is
    // not broken out of it, the note is queued for its next turn instead.
    const mode = deliveryMode(session, this.opts.sessions.isRunning(session.id));
    if (mode === 'turn') this.opts.sessions.startTurn(session, note);
    else this.opts.sessions.queueInterrupt(session.id, note);
    if (mode === 'queued') this.opts.sessions.notify?.('A2A watch', `${t.peer_id}'s task ${shortId(t.task_id)}: the check is met. Queued for the session's next turn to write the summary.`);
    this.audit.write({ event: 'watch.woke', peer: t.peer_id, taskId: t.task_id, sessionId: session.id, mode });
  }

  /**
   * onMet "complete" / timeout: tell the owning session without starting a
   * (paid) turn. It reads the note at the start of its next turn. Skipped
   * when the first check ran inside the A2AReply call itself: the tool
   * result already says what happened.
   */
  private notifyOwner(t: TaskRow, s: WatchState, note: string): void {
    const session = this.ownerSession(t, s);
    if (session && this.inlineWatch !== t.task_id) this.opts.sessions.queueInterrupt(session.id, note);
    this.opts.sessions.notify?.('A2A watch', note.replace(/^\[A2A watch\] /, ''));
  }

  /** Nobody is left to tell: stop checking for a peer that is no longer paired. */
  private stopPeerWatches(peerId: string, reason: string): void {
    for (const t of this.store.listWatchedTasks()) if (t.peer_id === peerId) this.stopWatch(t, reason);
  }

  private ownerSession(t: TaskRow, s: WatchState) {
    const rows = this.opts.sessions.listSessions().filter((r) => r.archived === 0);
    return rows.find((r) => r.id === s.sessionId) ?? rows.find((r) => r.id === t.session_id) ?? null;
  }

  // ---- push out (design 5.3) ---------------------------------------------------

  /**
   * Queue a push for every config on the task and try it at once. Persisted
   * first, so a crash or restart between "state changed" and "push sent"
   * still delivers it (the outbox survives).
   */
  private queuePush(t: TaskRow, body: StreamResponse): void {
    const cfgs = this.store.getPushConfigs(t.task_id);
    if (!cfgs.length) return;
    const now = this.now();
    for (const c of cfgs) {
      this.store.enqueueOutbox({
        peerId: t.peer_id,
        kind: 'push',
        taskId: t.task_id,
        payload: { configId: c.config_id, body },
        nextTryTs: now,
        expiresTs: now + RETRY.windowMs,
        now,
      });
    }
    this.kickFlush();
  }

  /**
   * Try everything that is due. Serialised: overlapping ticks share one run.
   * Returns once the attempt round is over (tests await it).
   */
  flushOutbox(): Promise<void> {
    if (this.flushing) return this.flushing;
    // Note: the body can finish synchronously (nothing due), so clear the
    // guard from a .finally on the stored promise, never from inside it, or
    // the assignment below would re-set it after it was cleared and wedge
    // every later flush.
    const run = (async () => {
      await Promise.resolve();
      for (let round = 0; round < 10; round++) {
        const due = this.store.dueOutbox(this.now());
        if (!due.length) break;
        for (const row of due) await this.attemptOutbox(row);
      }
    })();
    const guarded = run.finally(() => {
      if (this.flushing === guarded) this.flushing = null;
    });
    this.flushing = guarded;
    return guarded;
  }

  private async attemptOutbox(row: OutboxRow): Promise<void> {
    const now = this.now();
    const peer = this.store.getPeer(row.peer_id);
    if (!peer) {
      this.store.deleteOutbox(row.id);
      return;
    }
    if (row.expires_ts && now > row.expires_ts) {
      this.store.deleteOutbox(row.id);
      this.audit.write({ event: 'outbound.expired', peer: row.peer_id, kind: row.kind, taskId: row.task_id, attempts: row.attempts });
      if (row.kind === 'send' && row.task_id) this.markQueuedSendFailed(row.task_id, 'gave up after 24 hours: the peer never came back online.');
      return;
    }
    const payload = safeJson<Record<string, unknown>>(row.payload_json) ?? {};
    try {
      if (row.kind === 'push') await this.deliverPush(peer, payload as { configId: string; body: StreamResponse });
      else await this.deliverQueuedSend(peer, row, payload as { req: SendMessageRequest; localTaskId: string });
      this.store.deleteOutbox(row.id);
      this.store.touchPeer(peer.peer_id, this.now());
      if (row.kind === 'push') this.audit.write({ event: 'push.sent', peer: peer.peer_id, taskId: row.task_id, attempts: row.attempts + 1 });
    } catch (e) {
      const failures = row.attempts + 1;
      const msg = (e as Error).message;
      const terminalPush = row.kind === 'push' && this.pushIsTerminal(payload);
      const next = isRetryable(e) ? nextRetryTs(row.kind, terminalPush, failures, this.now(), row.expires_ts ?? now + RETRY.windowMs) : null;
      if (next === null) {
        this.store.deleteOutbox(row.id);
        this.audit.write({ event: row.kind === 'push' ? 'push.dropped' : 'outbound.failed', peer: peer.peer_id, taskId: row.task_id, attempts: failures, error: msg });
        if (row.kind === 'send' && row.task_id) this.markQueuedSendFailed(row.task_id, msg);
      } else {
        this.store.rescheduleOutbox(row.id, failures, next, msg);
        if (row.kind === 'push') this.audit.write({ event: 'push.failed', peer: peer.peer_id, taskId: row.task_id, attempts: failures, nextTry: next, error: msg });
      }
    }
  }

  private pushIsTerminal(payload: Record<string, unknown>): boolean {
    const st = (payload.body as StreamResponse | undefined)?.task?.status?.state;
    return !!st && TERMINAL_STATES.has(st);
  }

  private async deliverPush(peer: PeerRow, p: { configId: string; body: StreamResponse }): Promise<void> {
    const cfg = this.store.getPushConfig(p.configId);
    if (!cfg) return; // task forgotten; nothing to send
    await postPush(this.endpointFor(peer), cfg.url || '/a2a-push', p.body, this.store.getPushToken(cfg));
  }

  // ---- push in (design 5.3, 4.2.5) -------------------------------------------

  /**
   * POST /a2a-push. The bearer has already identified `peer`. Accept the
   * update only for a task WE created on that peer, with the per-task token we
   * issued, and only if it moves the task forward. Returns 200 for a harmless
   * duplicate or stale snapshot (the sender should stop retrying), and an
   * error for anything that looks like forgery.
   */
  private onPush(peer: PeerRow, body: StreamResponse, pushToken: string): { accepted: boolean; result: string } {
    const r = readStreamResponse(body);
    if (!r) throw errors.badRequest('Push body must be a StreamResponse with exactly one of task, message, statusUpdate, artifactUpdate.');
    const t = this.store.getTask(r.taskId);
    if (!t || t.direction !== 'out' || t.peer_id !== peer.peer_id) {
      this.audit.write({ event: 'push.rejected', peer: peer.peer_id, taskId: r.taskId, reason: 'unknown task' });
      throw errors.taskNotFound(r.taskId);
    }
    if (!hashMatches(t.push_token_hash, pushToken)) {
      this.audit.write({ event: 'push.rejected', peer: peer.peer_id, taskId: t.task_id, reason: 'push token mismatch' });
      throw errors.pushTokenMismatch();
    }
    const out = this.applyRemoteUpdate(t, r, 'push');
    return { accepted: out !== 'ignored', result: out };
  }

  /**
   * Fold a snapshot / message from the peer into an OUT task (push or poll).
   * Returns what happened, and wakes waiters on a real change.
   */
  private applyRemoteUpdate(
    t: TaskRow,
    r: NonNullable<ReturnType<typeof readStreamResponse>>,
    source: 'push' | 'poll'
  ): 'applied' | 'message' | 'ignored' {
    const now = this.now();
    if (r.message) {
      // A new agent message on the task: state unchanged, but a waiter may care.
      if (TERMINAL_STATES.has(t.state)) {
        this.audit.write({ event: 'push.ignored', peer: t.peer_id, taskId: t.task_id, reason: 'terminal', source });
        return 'ignored';
      }
      const seenKey = `msg:${r.message.messageId}`;
      if (this.store.seenMessage(t.peer_id, seenKey) !== null) return 'ignored';
      this.store.recordSeenMessage(t.peer_id, seenKey, t.task_id, now);
      const text = partsText(r.message.parts);
      this.store.patchTask(t.task_id, { lastPushTs: now }, now);
      this.audit.write({ event: 'push.received', peer: t.peer_id, taskId: t.task_id, kind: 'message', source, text });
      this.emit(t, 'message', t.state, text, false);
      return 'message';
    }
    const curStatus = safeJson<Task['status']>(t.last_status_json) ?? { state: t.state };
    const curArtifacts = safeJson<Artifact[]>(t.artifacts_json) ?? [];
    let nextStatus: Task['status'] | undefined = r.task?.status;
    let nextArtifacts: Artifact[] = r.task?.artifacts ?? curArtifacts;
    if (r.artifact) {
      nextStatus = curStatus;
      nextArtifacts = [...curArtifacts.filter((a) => a.artifactId !== r.artifact!.artifactId), r.artifact];
    }
    if (!nextStatus || !isTaskState(nextStatus.state)) {
      throw errors.badRequest('Push carries no valid task state.');
    }
    const verdict = judgeSnapshot(
      { state: t.state, statusTs: curStatus.timestamp, statusMessageId: curStatus.message?.messageId, artifactsCount: curArtifacts.length },
      { state: nextStatus.state, statusTs: nextStatus.timestamp, statusMessageId: nextStatus.message?.messageId, artifactsCount: nextArtifacts.length }
    );
    this.store.patchTask(t.task_id, { lastPushTs: now }, now);
    if (verdict !== 'apply') {
      this.audit.write({ event: 'push.ignored', peer: t.peer_id, taskId: t.task_id, reason: verdict, state: nextStatus.state, source });
      return 'ignored';
    }
    this.store.patchTask(t.task_id, { state: nextStatus.state, statusJson: JSON.stringify(nextStatus), artifactsJson: JSON.stringify(nextArtifacts) }, now);
    this.audit.write({ event: 'task.state', peer: t.peer_id, taskId: t.task_id, direction: 'out', from: t.state, state: nextStatus.state, source });
    const text = taskOutcomeText({ status: nextStatus, artifacts: nextArtifacts });
    this.emit(this.store.getTask(t.task_id)!, 'state', nextStatus.state, text, isApprovalPendingStatus(nextStatus));
    this.changed();
    return 'applied';
  }

  private emit(t: TaskRow, kind: 'state' | 'message', state: TaskState, text: string, approvalPending: boolean): void {
    const ev: A2ATaskEvent = {
      taskId: t.task_id,
      peerId: t.peer_id,
      contextId: t.context_id,
      direction: t.direction,
      state,
      kind,
      approvalPending,
      summary: t.summary,
      text,
    };
    const woke = this.waiters.onTaskEvent(ev);
    for (const s of woke) this.audit.write({ event: 'wait.woke', peer: t.peer_id, taskId: t.task_id, sessionId: s, state, kind });
    try {
      this.opts.onTaskEvent?.(ev);
    } catch {
      /* an observer must never break push handling */
    }
  }

  // ---- poll backstop (design 5.3, 6.4) ---------------------------------------

  /**
   * GET /tasks/{id} for each OUT task in scope of the wait that has had no
   * news for `staleMs`, fold the answer in, and return a resume note if the
   * wait is now satisfied. Never throws: an offline peer just means "not yet".
   */
  async pollForWait(state: WaitA2AState, staleMs = POLL_STALE_MS): Promise<string | null> {
    const candidates = this.tasksInScope(state);
    const now = this.now();
    for (const t of candidates) {
      // Something already in the DB may satisfy the wait (a push landed while
      // the session was busy waking): no network needed.
      const local = this.eventFromRow(t);
      if (eventWakes(state, local)) return resumeNote(local);
      const last = Math.max(t.last_push_ts ?? 0, t.updated_ts ?? 0, t.created_ts ?? 0);
      if (TERMINAL_STATES.has(t.state) || now - last < staleMs || t.task_id.startsWith('queued-')) continue;
      const peer = this.store.getPeer(t.peer_id);
      if (!peer) continue;
      try {
        const task = await clientGetTask(this.endpointFor(peer), t.task_id);
        this.audit.write({ event: 'poll.result', peer: peer.peer_id, taskId: t.task_id, state: task?.status?.state });
        if (task?.status && isTaskState(task.status.state)) {
          this.applyRemoteUpdate(t, { taskId: t.task_id, task }, 'poll');
        } else {
          this.store.patchTask(t.task_id, { lastPushTs: this.now() }, this.now());
        }
      } catch (e) {
        this.audit.write({ event: 'poll.result', peer: peer.peer_id, taskId: t.task_id, error: (e as Error).message });
        continue;
      }
      const fresh = this.store.getTask(t.task_id)!;
      const ev = this.eventFromRow(fresh);
      if (eventWakes(state, ev)) return resumeNote(ev);
    }
    return null;
  }

  private tasksInScope(state: WaitA2AState): TaskRow[] {
    if (state.taskIds.length) return state.taskIds.map((id) => this.store.getTask(id)).filter((t): t is TaskRow => !!t && t.direction === 'out');
    return this.store
      .listTasks({ direction: 'out', peerId: state.peer ?? undefined, contextId: state.contextId ?? undefined, limit: 50 })
      .filter((t) => (t.created_ts ?? 0) >= state.startedTs - 60_000 || !TERMINAL_STATES.has(t.state));
  }

  private eventFromRow(t: TaskRow): A2ATaskEvent {
    const status = safeJson<Task['status']>(t.last_status_json) ?? { state: t.state };
    const artifacts = safeJson<Artifact[]>(t.artifacts_json) ?? [];
    return {
      taskId: t.task_id,
      peerId: t.peer_id,
      contextId: t.context_id,
      direction: t.direction,
      state: t.state,
      kind: 'state',
      approvalPending: isApprovalPendingStatus(status),
      summary: t.summary,
      text: taskOutcomeText({ status, artifacts }),
    };
  }

  /** Validate WaitForA2A arguments into a stored state. Throws plain-English errors. */
  buildWait(args: { taskIds?: string[]; peer?: string; contextId?: string; states?: TaskState[] | null; timeoutMs: number }): WaitA2AState {
    const taskIds = (args.taskIds ?? []).map((r) => this.resolveTask(r, 'out').task_id);
    const peer = args.peer ? this.resolvePeer(args.peer).peer_id : null;
    const contextId = args.contextId?.trim() || null;
    if (!taskIds.length && !peer && !contextId) throw new Error('Say what to wait for: taskIds (from A2ARequest), a peer, or a contextId.');
    const now = this.now();
    return { taskIds, peer, contextId, states: args.states && args.states.length ? args.states : null, deadlineTs: now + args.timeoutMs, pollStaleMs: POLL_STALE_MS, startedTs: now };
  }

  /** Already satisfied by what we know locally? Returns the resume note, else null. */
  alreadySatisfied(state: WaitA2AState): string | null {
    for (const t of this.tasksInScope(state)) {
      const ev = this.eventFromRow(t);
      if (eventWakes(state, ev)) return resumeNote(ev);
    }
    return null;
  }

  private toTask(t: TaskRow): Task {
    let status: Task['status'] = { state: t.state };
    try {
      if (t.last_status_json) status = { ...JSON.parse(t.last_status_json), state: t.state };
    } catch {
      /* keep the bare state */
    }
    const artifacts = safeJson<Artifact[]>(t.artifacts_json);
    return { id: t.task_id, contextId: t.context_id ?? '', status, ...(artifacts?.length ? { artifacts } : {}) };
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

  /** A2ASend: inform. Queued in the outbox when the peer is offline. */
  async send(args: {
    peer: string;
    text: string;
    toSession?: string;
    toProject?: string;
    contextId?: string;
    fromSessionLabel?: string;
    fromProject?: string;
    sessionId?: string;
  }): Promise<SendResult> {
    return this.createTask({ ...args, kind: 'inform' });
  }

  /** A2ARequest: request / notify, with a push config so the answer comes back. */
  async request(args: {
    peer: string;
    text: string;
    kind: 'request' | 'notify';
    toSession?: string;
    toProject?: string;
    contextId?: string;
    fromSessionLabel?: string;
    fromProject?: string;
    sessionId?: string;
    watchSuggestion?: string;
    timeoutHint?: string;
  }): Promise<SendResult> {
    if (args.kind !== 'request' && args.kind !== 'notify') throw new Error('kind must be "request" or "notify".');
    return this.createTask(args);
  }

  private async createTask(args: {
    peer: string;
    text: string;
    kind: MessageKind;
    toSession?: string;
    toProject?: string;
    contextId?: string;
    fromSessionLabel?: string;
    fromProject?: string;
    sessionId?: string;
    watchSuggestion?: string;
    timeoutHint?: string;
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
    const metadata: Record<string, unknown> = { kind: args.kind, [ROUTING_METADATA_KEY]: routing };
    if (args.timeoutHint) metadata.timeoutHint = String(args.timeoutHint).slice(0, 100);
    // Watch extension (design 5.5): a suggested check is TEXT for the other
    // agent and its user to read. Their runtime never runs it as given.
    const suggestion = args.kind === 'notify' ? String(args.watchSuggestion ?? '').trim().slice(0, WATCH_SUGGESTION_MAX) : '';
    if (suggestion) {
      if (PAIRING_CODE_RE.test(suggestion)) throw new Error('Refusing to send an A2A pairing code inside a message. Pairing codes are secrets.');
      metadata[WATCH_METADATA_KEY] = { suggestion };
    }
    const req: SendMessageRequest = {
      message: {
        messageId: randomUUID(),
        role: 'ROLE_USER',
        parts: [{ text }],
        ...(args.contextId ? { contextId: args.contextId } : {}),
        metadata,
        extensions: suggestion ? [EXT_ROUTING, EXT_WATCH] : [EXT_ROUTING],
      },
      configuration: { returnImmediately: true },
    };
    let pushToken: string | null = null;
    if (args.kind !== 'inform') {
      // Per-task 128-bit token (design 5.3). We keep only its hash.
      pushToken = randomBytes(16).toString('base64url');
      req.configuration!.taskPushNotificationConfig = { url: `${this.origin()}/a2a-push`, token: pushToken };
    }
    try {
      const res = await sendMessage(this.endpointFor(peer), req);
      const task = res.task;
      if (!task?.id) throw new Error('The peer answered without a task.');
      if (this.store.getTask(task.id)) throw new Error('The peer returned a task id that already exists here; refusing to overwrite it.');
      this.store.insertTask({
        taskId: task.id,
        peerId: peer.peer_id,
        direction: 'out',
        contextId: task.contextId ?? null,
        sessionId: args.sessionId ?? null,
        kind: args.kind,
        state: isTaskState(task.status?.state) ? task.status.state : 'TASK_STATE_SUBMITTED',
        summary: text.slice(0, 200),
        requestJson: JSON.stringify(req.message),
        statusJson: JSON.stringify(task.status ?? null),
        artifactsJson: task.artifacts ? JSON.stringify(task.artifacts) : null,
        pushTokenHash: pushToken ? sha256Hex(pushToken) : null,
        now: this.now(),
      });
      if (task.contextId && args.sessionId) this.store.setContext(task.contextId, peer.peer_id, args.sessionId, this.now());
      this.store.touchPeer(peer.peer_id, this.now());
      this.audit.write({ event: 'outbound.message', peer: peer.peer_id, kind: args.kind, taskId: task.id, contextId: task.contextId, text });
      this.changed();
      return { peer, taskId: task.id, contextId: task.contextId, state: task.status?.state ?? 'TASK_STATE_SUBMITTED' };
    } catch (e) {
      this.audit.write({ event: 'outbound.failed', peer: peer.peer_id, kind: args.kind, error: (e as Error).message });
      if (e instanceof PeerOfflineError) return this.queueSend(peer, req, args, text, pushToken);
      throw e;
    }
  }

  /**
   * Peer offline (design 6.6): park the exact request in the outbox and keep
   * a local placeholder task so the user and WaitForA2A can see it. The
   * messageId is fixed now, so a retry that did reach them but lost the
   * answer is deduplicated on their side.
   */
  private queueSend(
    peer: PeerRow,
    req: SendMessageRequest,
    args: { kind: MessageKind; sessionId?: string },
    text: string,
    pushToken: string | null
  ): SendResult {
    const now = this.now();
    const localTaskId = `queued-${randomUUID()}`;
    this.store.insertTask({
      taskId: localTaskId,
      peerId: peer.peer_id,
      direction: 'out',
      contextId: req.message.contextId ?? null,
      sessionId: args.sessionId ?? null,
      kind: args.kind,
      state: 'TASK_STATE_SUBMITTED',
      summary: text.slice(0, 200),
      requestJson: JSON.stringify(req.message),
      statusJson: JSON.stringify({ state: 'TASK_STATE_SUBMITTED', message: { messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text: 'Queued: the peer is offline.' }] } }),
      pushTokenHash: pushToken ? sha256Hex(pushToken) : null,
      now,
    });
    const expires = now + RETRY.windowMs;
    const id = this.store.enqueueOutbox({ peerId: peer.peer_id, kind: 'send', taskId: localTaskId, payload: { req, localTaskId }, nextTryTs: now + RETRY.fastDelaysMs[0], expiresTs: expires, now });
    // The attempt that just failed counts, so the backoff continues 8s, 30s, ...
    this.store.rescheduleOutbox(id, 1, now + RETRY.fastDelaysMs[0], 'peer offline');
    this.audit.write({ event: 'outbound.queued', peer: peer.peer_id, kind: args.kind, taskId: localTaskId, until: expires, text });
    this.changed();
    return { peer, taskId: localTaskId, contextId: req.message.contextId ?? '', state: 'TASK_STATE_SUBMITTED', queued: true, queuedUntil: expires };
  }

  private async deliverQueuedSend(peer: PeerRow, row: OutboxRow, p: { req: SendMessageRequest; localTaskId: string }): Promise<void> {
    const res = await sendMessage(this.endpointFor(peer), p.req);
    const task = res.task;
    if (!task?.id) throw new A2AClientError('The peer answered without a task.', 502);
    const local = this.store.getTask(p.localTaskId);
    // Swap the placeholder for the real task id, keeping everything else.
    // Waiters that named the placeholder are pointed at the new id.
    this.opts.sql.prepare('UPDATE a2a_tasks SET task_id = ?, context_id = COALESCE(?, context_id) WHERE task_id = ?').run(task.id, task.contextId ?? null, p.localTaskId);
    const st = isTaskState(task.status?.state) ? task.status.state : 'TASK_STATE_SUBMITTED';
    this.store.patchTask(task.id, { state: st, statusJson: JSON.stringify(task.status ?? { state: st }), ...(task.artifacts ? { artifactsJson: JSON.stringify(task.artifacts) } : {}) }, this.now());
    if (task.contextId && local?.session_id) this.store.setContext(task.contextId, peer.peer_id, local.session_id, this.now());
    try {
      this.opts.waits?.renameTask?.(p.localTaskId, task.id);
    } catch {
      /* best effort */
    }
    this.audit.write({ event: 'outbound.message', peer: peer.peer_id, kind: local?.kind, taskId: task.id, contextId: task.contextId, fromQueue: true, attempts: row.attempts + 1 });
    this.changed();
    const fresh = this.store.getTask(task.id);
    if (fresh) this.emit(fresh, 'state', fresh.state, taskOutcomeText(this.toTask(fresh)), false);
  }

  private markQueuedSendFailed(localTaskId: string, why: string): void {
    const t = this.store.getTask(localTaskId);
    if (!t || TERMINAL_STATES.has(t.state)) return;
    const status = { state: 'TASK_STATE_FAILED' as TaskState, timestamp: new Date(this.now()).toISOString(), message: { messageId: randomUUID(), role: 'ROLE_AGENT' as const, parts: [{ text: `Not delivered: ${why}` }] } };
    this.store.patchTask(localTaskId, { state: 'TASK_STATE_FAILED', statusJson: JSON.stringify(status) }, this.now());
    this.audit.write({ event: 'task.state', peer: t.peer_id, taskId: localTaskId, direction: 'out', state: 'TASK_STATE_FAILED', reason: why });
    this.emit(this.store.getTask(localTaskId)!, 'state', 'TASK_STATE_FAILED', `Not delivered: ${why}`, false);
    this.changed();
  }

  /** A2ACancel. Outbound: CancelTask on the peer. Inbound: cancel our side and tell the requester. */
  async cancel(ref: string): Promise<{ task: TaskRow; note: string }> {
    const t = this.resolveTask(ref);
    if (TERMINAL_STATES.has(t.state)) return { task: t, note: `already ${stateWord(t.state)}` };
    if (t.direction === 'in') {
      if (t.approval === 'pending') this.store.patchTask(t.task_id, { approval: 'cancelled' }, this.now());
      this.setInboundState(t, 'TASK_STATE_CANCELED', `${this.opts.displayName}'s agent cancelled this.`);
      this.changed();
      return { task: this.store.getTask(t.task_id)!, note: 'cancelled; the requester has been told' };
    }
    const outbox = this.store.listOutbox(t.peer_id).find((r) => r.kind === 'send' && r.task_id === t.task_id);
    if (outbox) {
      this.store.deleteOutbox(outbox.id);
      this.setOutboundCanceled(t, 'Cancelled before it was delivered.');
      return { task: this.store.getTask(t.task_id)!, note: 'it had not been delivered yet; removed from the queue' };
    }
    const peer = this.store.getPeer(t.peer_id);
    if (!peer) throw new Error(`The peer for task ${shortId(t.task_id)} is no longer paired.`);
    const remote = await clientCancelTask(this.endpointFor(peer), t.task_id).catch((e) => {
      if (e instanceof A2AClientError && e.reason === 'TASK_NOT_CANCELABLE') return null;
      throw e;
    });
    if (remote?.status && isTaskState(remote.status.state)) {
      this.applyRemoteUpdate(t, { taskId: t.task_id, task: remote }, 'poll');
    } else {
      // It finished on their side before our cancel landed: fetch the truth.
      const now = await clientGetTask(this.endpointFor(peer), t.task_id).catch(() => null);
      if (now?.status && isTaskState(now.status.state)) this.applyRemoteUpdate(t, { taskId: t.task_id, task: now }, 'poll');
    }
    const fresh = this.store.getTask(t.task_id)!;
    return { task: fresh, note: fresh.state === 'TASK_STATE_CANCELED' ? 'cancelled on their side' : `it was already ${stateWord(fresh.state)} on their side` };
  }

  private setOutboundCanceled(t: TaskRow, why: string): void {
    const status = { state: 'TASK_STATE_CANCELED' as TaskState, timestamp: new Date(this.now()).toISOString(), message: { messageId: randomUUID(), role: 'ROLE_AGENT' as const, parts: [{ text: why }] } };
    this.store.patchTask(t.task_id, { state: 'TASK_STATE_CANCELED', statusJson: JSON.stringify(status) }, this.now());
    this.audit.write({ event: 'task.state', peer: t.peer_id, taskId: t.task_id, direction: 'out', state: 'TASK_STATE_CANCELED' });
    this.changed();
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
    this.changed();
    return peer;
  }

  /**
   * Unpair. Tells the peer first (best effort, 3 seconds, design 4.3 step 5)
   * while we still hold their token, then forgets them locally whatever the
   * outcome: an offline peer just finds its token rejected later.
   */
  async revoke(peerRef: string): Promise<PeerRow> {
    const peer = this.resolvePeer(peerRef);
    let told = false;
    try {
      await notifyUnpair(this.endpointFor(peer), 3000);
      told = true;
    } catch {
      /* offline or already gone */
    }
    this.stopPeerWatches(peer.peer_id, 'peer revoked');
    this.store.deletePeer(peer.peer_id);
    for (const r of this.store.listOutbox(peer.peer_id)) this.store.deleteOutbox(r.id);
    this.audit.write({ event: 'peer.revoked', peer: peer.peer_id, notified: told });
    this.changed();
    return peer;
  }

  /**
   * Change a peer's trust. `expiresAt` time-boxes it: at expiry the previous
   * level comes back (effectiveTrust). Escalation policy (who may raise
   * trust) is enforced by the callers: the tool refuses it, the UI asks.
   */
  setTrust(peerRef: string, trust: TrustLevel, opts: { expiresAt?: number | null; by?: string } = {}): PeerRow {
    const peer = this.resolvePeer(peerRef);
    this.store.setTrust(peer.peer_id, trust, { now: this.now(), expiresTs: opts.expiresAt ?? null });
    this.audit.write({ event: 'trust.changed', peer: peer.peer_id, from: peer.trust, to: trust, expires: opts.expiresAt ?? null, by: opts.by ?? 'model' });
    this.changed();
    return this.store.getPeer(peer.peer_id)!;
  }
}

/** Cap on a requester's suggested watch check (design 5.5). Display text only. */
const WATCH_SUGGESTION_MAX = 500;

/**
 * The text a session sees for an inbound message: its parts, then any
 * suggested watch check from `metadata["ocient.watch"].suggestion`, labelled
 * as a suggestion. That label is the ONLY place a suggestion goes: it ends up
 * inside the untrusted-content envelope for the local model and user to read.
 * The watch runner never sees the message (watch.ts SECURITY).
 */
function inboundText(msg: Message, dialect?: EnvelopeDialect): string {
  const body = (msg.parts ?? []).map((p) => (p.text !== undefined ? p.text : '```json\n' + JSON.stringify(p.data, null, 2) + '\n```')).join('\n\n');
  const w = (msg.metadata as Record<string, unknown> | undefined)?.[WATCH_METADATA_KEY];
  const raw = w && typeof w === 'object' && !Array.isArray(w) ? (w as WatchSuggestionInfo).suggestion : undefined;
  const suggestion = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, WATCH_SUGGESTION_MAX) : '';
  if (!suggestion) return body;
  return (
    `${body}\n\n(Their agent suggests a check for this: "${suggestion}". It is only a suggestion and has not been run. ` +
    `If you watch this with ${dialect === 'claude-code' ? 'a2a_watch' : 'A2AReply action "watch"'}, write your own command and make sure it is safe.)`
  );
}

function safeJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
