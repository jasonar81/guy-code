/**
 * A2A relay server (docs/a2a/DESIGN.md 11a). Standalone: no Electron, no
 * imports from electron/, no runtime dependencies beyond Node >= 20.
 *
 * WHY THIS TRANSPORT. On a Fortinet-style SSL VPN each laptop gets a /32 and
 * the gateway forwards only connections the laptop itself opened, so no agent
 * can ever accept a connection. Every connection here is therefore opened BY
 * the agent:
 *   GET  /relay/v1/stream  long-lived Server-Sent Events, relay -> agent
 *   POST /relay/v1/send    agent -> relay, one envelope; the HTTP response is
 *                          the recipient's reply (correlated by msgId)
 * SSE rather than WebSocket or a raw socket: it is ordinary HTTP (a GET whose
 * response never ends), so it passes corporate proxies and inspection boxes
 * that mangle Upgrade requests, it needs no new dependency on either side
 * (node:http on both), and agent -> relay traffic is plain POSTs that any HTTP
 * stack can retry. The cost - one extra request per message - is irrelevant at
 * A2A message rates.
 *
 * PROTOCOL
 *   1. Agent opens GET /relay/v1/stream. First event: `challenge`
 *      {streamId, nonce}. The stream is unauthenticated and is closed if no
 *      proof arrives within authTimeoutMs.
 *   2. Agent POSTs /relay/v1/auth {streamId, fingerprint, certPem, signature}
 *      where signature = ECDSA-SHA256 over "a2a-relay-auth-v1\n<nonce>" with
 *      its cert key (identity.ts). Success -> {session}; the stream gets a
 *      `ready` event and then any queued mail. Failure -> 401 AND the stream
 *      is closed, so a nonce gets exactly one guess.
 *   3. POST /relay/v1/send   (Bearer session) {to, from, msgId, iv, ct, tag}.
 *      Recipient online: delivered as event `envelope`, and the POST is held
 *      until the reply (200 {status:'delivered', reply}) or replyTimeoutMs
 *      (202 {status:'awaiting_reply'}; the reply later arrives on the sender's
 *      stream as event `reply`). Recipient offline: queued, 202
 *      {status:'queued'}.
 *   4. POST /relay/v1/reply  (Bearer session) {to, from, msgId, iv, ct, tag}
 *      with msgId = the msgId being answered. Every envelope gets exactly one
 *      reply, and the reply is the delivery ack.
 *   5. Anything the relay drops (TTL expiry, recipient queue full) is logged
 *      and reported to its sender: synchronously as an error when possible,
 *      otherwise as event `dropped` {msgId, to, reason} on the sender's stream
 *      (queued if the sender is offline too).
 *
 * THE RELAY CANNOT READ PAYLOADS. It accepts exactly the six fields
 * {to, from, msgId, iv, ct, tag} and rejects any other field, so a client bug
 * cannot smuggle plaintext alongside the ciphertext. `ct` is checked only for
 * type, size and base64 alphabet - it is never decoded, parsed or logged, and
 * neither are iv, tag or full fingerprints (log.ts enforces this). What the
 * relay still sees is metadata: who talks to whom, when, how often and how
 * much. See README.md.
 *
 * PERSISTENCE: in memory only (v1). Rationale: the queue is bounded and short
 * lived (24h TTL, the same window as the agents' own outbox in
 * electron/a2a/push.ts), the agents already retry from their own outbox, and
 * not persisting means a stolen relay disk holds no ciphertext at all.
 * Caveat: a relay restart loses anything queued; senders are not told. The
 * agents' outbox retry covers that.
 *
 * DELIVERY SEMANTICS: envelopes are at-least-once. A message written to a
 * stream stays "in flight" until its reply; if that stream dies first, the
 * message goes back to the front of the queue and is redelivered on
 * reconnect (recipients dedupe by msgId). Replies and `dropped` notices are
 * at-most-once when written to a stream that then dies.
 *
 * ROOMS (DESIGN.md 11b). A room is a mailbox: an opaque, client-generated id
 * (16-128 chars of [A-Za-z0-9_-]) plus a set of member fingerprints. The relay
 * holds NOTHING else about it - not the room key, not the roster's public
 * keys, not display names, not any plaintext. Members encrypt (and sign)
 * before posting; the relay only fans ciphertext out.
 *   POST /relay/v1/rooms/join  {room}  -> 200 {room, members, joined}
 *   POST /relay/v1/rooms/leave {room}  -> 200 {room, left: true}
 *   POST /relay/v1/send  with to = "room:<id>" (still exactly the six fields)
 *        -> 202 {status:'posted', msgId, delivered, queued, dropped:[{to, reason}]}
 *        Each CURRENT member except the sender gets event `envelope` (to stays
 *        "room:<id>", from = the proven sender), or has it queued if offline,
 *        with the per-destination bound and TTL applied per member. There is
 *        no reply: the recipient acknowledges with
 *   POST /relay/v1/ack {room, sender, msgId} -> 200; until then the message is
 *        in flight and is redelivered if the member's stream dies (same
 *        at-least-once rule as direct envelopes).
 *   Events: `room_member` {room, fingerprint, change:'joined'|'left'} to the
 *        other members who are online; `room_snapshot` {room, members} for
 *        each of an agent's rooms right after `ready`, before queued mail, so a
 *        member that was offline resynchronises without a queue of old events.
 *
 * WHY "ANYONE AUTHENTICATED CAN JOIN ANY ROOM ID" IS NOT A HOLE. The relay
 * cannot check an invite code: the code carries the room key, and the relay
 * must never see that key. So a join here is only an assertion by an agent
 * that has proved its own identity. That is harmless for confidentiality and
 * integrity, because the real gates are end to end: without the room key a
 * joiner can read nothing (it receives AES-GCM ciphertext) and write nothing
 * that decrypts, and without being on the members' roster its signature will
 * not verify, so members drop whatever it posts. What a stranger who learns a
 * room id CAN get is metadata - the member fingerprints, and when and how much
 * the members post - plus the ability to send members junk that they discard
 * (bounded by the rate limit and per-member queue). Room ids should therefore
 * be random and treated as semi-secret, and are never logged in full (6-char
 * prefix only, log.ts roomPrefix). Joining requires an authenticated session;
 * an unauthenticated stream can never join, post or receive.
 *
 * ROOM PERSISTENCE: in memory, like the queue. Membership survives an agent
 * disconnecting (that is what makes offline delivery work) but NOT a relay
 * restart: after a restart every room is gone and members must re-join
 * (clients should re-join their rooms each time they authenticate; join is
 * idempotent).
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { isFingerprint, verifyProof } from './identity';
import { RelayLogger, fpPrefix, roomPrefix } from './log';

export const RELAY_VERSION = '1';

export interface RelayLimits {
  /** Max bytes of one POST body (an envelope). 256 KiB A2A body cap, base64-inflated, plus headers. */
  maxEnvelopeBytes: number;
  /** send + reply calls per agent per minute (design 4.2.6 uses 60/min per peer; a relay agent talks to many peers). */
  sendsPerMinutePerAgent: number;
  /** Queued + in-flight envelopes per destination. */
  maxQueuedPerDestination: number;
  /** Queued envelopes across all destinations (bounds memory against made-up fingerprints). */
  maxQueuedTotal: number;
  /** Open streams, authenticated or not. */
  maxStreams: number;
  /** How long an undelivered envelope is kept. Matches the agents' 24h outbox window. */
  queueTtlMs: number;
  /** How long POST /send waits for the recipient's reply before answering 202. */
  replyTimeoutMs: number;
  /** An unauthenticated stream must prove identity within this. */
  authTimeoutMs: number;
  /** Stream opens + auth attempts per source address per minute. */
  connectsPerMinutePerIp: number;
  /** SSE comment heartbeat, keeps proxies and NATs from idling the stream out. */
  heartbeatMs: number;
  /** `dropped` notices held for an offline sender. */
  maxNoticesPerAgent: number;
  /** Rooms one agent may be a member of at once. */
  maxRoomsPerAgent: number;
  /** Members in one room. */
  maxMembersPerRoom: number;
  /** Rooms in existence (bounds memory against made-up room ids). */
  maxRooms: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxEnvelopeBytes: 512 * 1024,
  sendsPerMinutePerAgent: 300,
  maxQueuedPerDestination: 200,
  maxQueuedTotal: 20_000,
  maxStreams: 500,
  queueTtlMs: 24 * 60 * 60_000,
  replyTimeoutMs: 25_000,
  authTimeoutMs: 10_000,
  connectsPerMinutePerIp: 30,
  heartbeatMs: 15_000,
  maxNoticesPerAgent: 500,
  maxRoomsPerAgent: 50,
  maxMembersPerRoom: 50,
  maxRooms: 5_000,
};

export interface RelayServerOptions {
  host?: string;
  /** 0 for an ephemeral port (tests). */
  port: number;
  /** PEM cert + key for HTTPS. Omit for plain HTTP (behind a TLS proxy, or tests). */
  tls?: { certPem: string; keyPem: string };
  limits?: Partial<RelayLimits>;
  logger?: RelayLogger;
  now?: () => number;
}

/** The ONLY shape the relay accepts or stores. */
export interface RelayEnvelope {
  to: string;
  from: string;
  msgId: string;
  iv: string;
  ct: string;
  tag: string;
}

const ENVELOPE_FIELDS = ['to', 'from', 'msgId', 'iv', 'ct', 'tag'] as const;
const MSG_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const IV_B64_LEN = 16; // 12-byte GCM nonce
const TAG_B64_LEN = 24; // 16-byte GCM tag
/** Opaque client-generated room id. Min 16 chars so ids are guessable only if a client is careless. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** `to` of a room post is ROOM_ADDRESS_PREFIX + room id; a fingerprint is never addressed this way. */
export const ROOM_ADDRESS_PREFIX = 'room:';

/** The room id of a `to` field, or null if `to` addresses a single agent. */
export function roomOfAddress(to: string): string | null {
  return to.startsWith(ROOM_ADDRESS_PREFIX) ? to.slice(ROOM_ADDRESS_PREFIX.length) : null;
}

class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/**
 * Structural check only. Rejects unknown fields so nothing but ciphertext can
 * ride along. `ct` is checked for type, non-emptiness and base64 alphabet; it
 * is NEVER decoded or parsed.
 */
export function validateEnvelope(x: unknown): RelayEnvelope {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new RelayError(400, 'bad_envelope', 'Body must be a JSON object {to, from, msgId, iv, ct, tag}.');
  const o = x as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(ENVELOPE_FIELDS as readonly string[]).includes(k));
  if (extra.length) {
    throw new RelayError(400, 'bad_envelope', `Unexpected field(s): ${extra.slice(0, 5).join(', ')}. The relay accepts only {to, from, msgId, iv, ct, tag}; encrypt everything else.`);
  }
  for (const f of ENVELOPE_FIELDS) if (typeof o[f] !== 'string') throw new RelayError(400, 'bad_envelope', `Field "${f}" must be a string.`);
  const room = roomOfAddress(o.to as string);
  if (room !== null) {
    if (!ROOM_ID_RE.test(room)) throw new RelayError(400, 'bad_envelope', `Field "to" addresses a room, so it must be "${ROOM_ADDRESS_PREFIX}" followed by 16-128 chars of [A-Za-z0-9_-].`);
  } else if (!isFingerprint(o.to)) {
    throw new RelayError(400, 'bad_envelope', `Field "to" must be a lowercase SHA-256 hex certificate fingerprint, or "${ROOM_ADDRESS_PREFIX}<room id>".`);
  }
  if (!isFingerprint(o.from)) throw new RelayError(400, 'bad_envelope', 'Field "from" must be a lowercase SHA-256 hex certificate fingerprint.');
  if (o.to === o.from) throw new RelayError(400, 'bad_envelope', 'An agent cannot send to itself.');
  if (!MSG_ID_RE.test(o.msgId as string)) throw new RelayError(400, 'bad_envelope', 'Field "msgId" must be 1-128 chars of [A-Za-z0-9._:-].');
  if ((o.iv as string).length !== IV_B64_LEN || !BASE64_RE.test(o.iv as string)) throw new RelayError(400, 'bad_envelope', 'Field "iv" must be a base64 12-byte GCM nonce.');
  if ((o.tag as string).length !== TAG_B64_LEN || !BASE64_RE.test(o.tag as string)) throw new RelayError(400, 'bad_envelope', 'Field "tag" must be a base64 16-byte GCM tag.');
  if (!(o.ct as string).length || !BASE64_RE.test(o.ct as string)) throw new RelayError(400, 'bad_envelope', 'Field "ct" must be non-empty base64 ciphertext.');
  // Copy exactly the six fields; never keep a reference to the parsed body.
  return { to: o.to as string, from: o.from as string, msgId: o.msgId as string, iv: o.iv as string, ct: o.ct as string, tag: o.tag as string };
}

/** Body of /rooms/join and /rooms/leave: exactly {room}. */
function parseRoomBody(x: unknown): string {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new RelayError(400, 'bad_room', 'Body must be a JSON object {room}.');
  const o = x as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'room');
  if (extra.length) throw new RelayError(400, 'bad_room', `Unexpected field(s): ${extra.slice(0, 5).join(', ')}. The relay accepts only {room}; it never holds a room key, roster or name.`);
  if (typeof o.room !== 'string' || !ROOM_ID_RE.test(o.room)) throw new RelayError(400, 'bad_room', 'Field "room" must be 16-128 chars of [A-Za-z0-9_-] (a random, client-generated id).');
  return o.room;
}

/** Body of /ack: exactly {room, sender, msgId}. */
function parseAckBody(x: unknown): { room: string; sender: string; msgId: string } {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new RelayError(400, 'bad_ack', 'Body must be a JSON object {room, sender, msgId}.');
  const o = x as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'room' && k !== 'sender' && k !== 'msgId');
  if (extra.length) throw new RelayError(400, 'bad_ack', `Unexpected field(s): ${extra.slice(0, 5).join(', ')}. An ack is only {room, sender, msgId}.`);
  if (typeof o.room !== 'string' || !ROOM_ID_RE.test(o.room)) throw new RelayError(400, 'bad_ack', 'Field "room" must be a room id.');
  if (!isFingerprint(o.sender)) throw new RelayError(400, 'bad_ack', 'Field "sender" must be the posting agent\'s fingerprint (the envelope\'s "from").');
  if (typeof o.msgId !== 'string' || !MSG_ID_RE.test(o.msgId)) throw new RelayError(400, 'bad_ack', 'Field "msgId" must be 1-128 chars of [A-Za-z0-9._:-].');
  return { room: o.room, sender: o.sender, msgId: o.msgId };
}

type QueueItem =
  | { kind: 'message'; env: RelayEnvelope; enqueuedAt: number }
  | { kind: 'reply'; env: RelayEnvelope; enqueuedAt: number }
  /** One member's copy of a room post; env.to is "room:<id>". */
  | { kind: 'room'; env: RelayEnvelope; enqueuedAt: number }
  | { kind: 'notice'; notice: DropNotice; enqueuedAt: number };

interface DropNotice {
  msgId: string;
  /** The destination that did not get it: an agent fingerprint (for a room post, the member). */
  to: string;
  /** Set when the dropped message was a room post. */
  room?: string;
  reason: string;
}

/** A room post written to one member's stream and not yet acknowledged. */
interface RoomInflight {
  env: RelayEnvelope;
  member: string;
  room: string;
  enqueuedAt: number;
  streamId: string;
}

interface Stream {
  id: string;
  res: http.ServerResponse;
  remote: string;
  nonce: string;
  fingerprint?: string;
  session?: string;
  closed: boolean;
  authTimer?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
}

interface Inflight {
  env: RelayEnvelope;
  enqueuedAt: number;
  streamId: string;
}

interface SendResult {
  status: number;
  body: Record<string, unknown>;
}

interface PendingSend {
  resolve: (r: SendResult) => void;
  timer: NodeJS.Timeout;
}

/** Fixed one-minute window per key (same scheme as electron/a2a/server.ts). */
class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly max: () => number,
    private readonly now: () => number
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.max();
  }
}

const inflightKey = (sender: string, msgId: string) => `${sender}|${msgId}`;
const roomInflightKey = (member: string, room: string, sender: string, msgId: string) => `${member}|${room}|${sender}|${msgId}`;
const shortId = (id: string) => id.slice(0, 16);

export class RelayServer {
  readonly limits: RelayLimits;
  private server: http.Server | https.Server | null = null;
  private actualPort = 0;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly log: RelayLogger;
  private readonly startedAt: number;
  private readonly agentLimiter: RateLimiter;
  private readonly ipLimiter: RateLimiter;

  private readonly streams = new Map<string, Stream>(); // streamId -> stream (pending and authenticated)
  private readonly byFingerprint = new Map<string, Stream>(); // authenticated only, one per identity
  private readonly sessions = new Map<string, Stream>(); // session token -> stream
  private readonly queues = new Map<string, QueueItem[]>(); // destination fingerprint -> FIFO
  private readonly inflight = new Map<string, Inflight>(); // sender|msgId -> delivered, awaiting reply
  private readonly pending = new Map<string, PendingSend>(); // sender|msgId -> held POST /send
  private readonly rooms = new Map<string, Set<string>>(); // room id -> member fingerprints (join order)
  private readonly agentRooms = new Map<string, Set<string>>(); // fingerprint -> room ids it belongs to
  private readonly roomInflight = new Map<string, RoomInflight>(); // member|room|sender|msgId -> awaiting ack

  constructor(private readonly opts: RelayServerOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? new RelayLogger();
    this.startedAt = this.now();
    this.agentLimiter = new RateLimiter(() => this.limits.sendsPerMinutePerAgent, this.now);
    this.ipLimiter = new RateLimiter(() => this.limits.connectsPerMinutePerIp, this.now);
  }

  port(): number {
    return this.actualPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handle(req, res).catch((e) => this.sendError(res, e));
    };
    const server = this.opts.tls
      ? https.createServer({ cert: this.opts.tls.certPem, key: this.opts.tls.keyPem, minVersion: 'TLSv1.2' }, handler)
      : http.createServer(handler);
    // Slow-loris guard on request bodies. SSE responses are unaffected: their
    // request (a bodiless GET) is complete as soon as the headers arrive.
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e) => {
        this.server = null;
        reject(e);
      });
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => {
        this.actualPort = (server.address() as AddressInfo).port;
        resolve();
      });
    });
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
    this.log.info('relay_started', { port: this.actualPort, tls: !!this.opts.tls });
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ status: 503, body: { error: { code: 'shutting_down', message: 'Relay is shutting down.' } } });
    }
    this.pending.clear();
    for (const st of [...this.streams.values()]) this.closeStream(st, 'shutdown');
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      (s as http.Server).closeAllConnections?.();
    });
    this.log.info('relay_stopped');
  }

  /** Counts only - safe for /health. */
  stats(): { streams: number; agents: number; queued: number; inflight: number; rooms: number; memberships: number; roomInflight: number } {
    let queued = 0;
    for (const q of this.queues.values()) queued += q.length;
    let memberships = 0;
    for (const m of this.rooms.values()) memberships += m.size;
    return {
      streams: this.streams.size,
      agents: this.byFingerprint.size,
      queued,
      inflight: this.inflight.size,
      rooms: this.rooms.size,
      memberships,
      roomInflight: this.roomInflight.size,
    };
  }

  /**
   * Everything the relay currently holds, serialised. For tests that assert
   * no plaintext is ever stored; also handy for debugging.
   */
  dumpState(): string {
    return JSON.stringify({
      queues: [...this.queues.entries()],
      inflight: [...this.inflight.entries()],
      roomInflight: [...this.roomInflight.entries()],
      rooms: [...this.rooms.entries()].map(([id, m]) => [id, [...m]]),
      streams: [...this.streams.values()].map((s) => ({ id: s.id, fingerprint: s.fingerprint, remote: s.remote })),
    });
  }

  // ---- routing ---------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const remote = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

    if (method === 'GET' && path === '/relay/v1/health') {
      return this.sendJson(res, 200, { ok: true, version: RELAY_VERSION, uptimeS: Math.floor((this.now() - this.startedAt) / 1000), ...this.stats() });
    }
    if (method === 'GET' && path === '/relay/v1/stream') return this.openStream(req, res, remote);
    if (method === 'POST' && path === '/relay/v1/auth') return this.handleAuth(req, res, remote);
    if (method === 'POST' && (path === '/relay/v1/send' || path === '/relay/v1/reply')) {
      const st = this.authenticate(req);
      if (!this.agentLimiter.allow(st.fingerprint!)) {
        this.log.warn('rate_limited', { agent: fpPrefix(st.fingerprint), route: path });
        throw new RelayError(429, 'rate_limited', `Rate limit exceeded: at most ${this.limits.sendsPerMinutePerAgent} sends per minute per agent.`);
      }
      const env = validateEnvelope(await this.readJson(req));
      if (env.from !== st.fingerprint) throw new RelayError(403, 'wrong_sender', '"from" does not match the identity this session proved.');
      const room = roomOfAddress(env.to);
      if (room !== null && path === '/relay/v1/reply') {
        throw new RelayError(400, 'bad_envelope', 'Room posts have no reply; acknowledge them with POST /relay/v1/ack, and answer by posting to the room.');
      }
      const r = room !== null ? this.handleRoomPost(room, env) : path === '/relay/v1/send' ? await this.handleSend(env) : this.handleReply(env);
      return this.sendJson(res, r.status, r.body);
    }
    if (method === 'POST' && (path === '/relay/v1/rooms/join' || path === '/relay/v1/rooms/leave')) {
      const st = this.authenticate(req);
      if (!this.agentLimiter.allow(st.fingerprint!)) {
        this.log.warn('rate_limited', { agent: fpPrefix(st.fingerprint), route: path });
        throw new RelayError(429, 'rate_limited', `Rate limit exceeded: at most ${this.limits.sendsPerMinutePerAgent} sends per minute per agent.`);
      }
      const room = parseRoomBody(await this.readJson(req));
      const r = path === '/relay/v1/rooms/join' ? this.joinRoom(st.fingerprint!, room) : this.leaveRoom(st.fingerprint!, room);
      return this.sendJson(res, r.status, r.body);
    }
    if (method === 'POST' && path === '/relay/v1/ack') {
      // Not rate limited: an ack can only release state the relay already holds.
      const st = this.authenticate(req);
      const r = this.handleAck(st.fingerprint!, await this.readJson(req));
      return this.sendJson(res, r.status, r.body);
    }
    throw new RelayError(404, 'not_found', `No route for ${method} ${path}.`);
  }

  private authenticate(req: http.IncomingMessage): Stream {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
    const st = m ? this.sessions.get(m[1]) : undefined;
    if (!st || st.closed || !st.fingerprint) {
      throw new RelayError(401, 'unauthenticated', 'Missing or stale session. Open /relay/v1/stream and complete /relay/v1/auth; a session lives as long as its stream.');
    }
    return st;
  }

  // ---- streams ---------------------------------------------------------------

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, remote: string): void {
    if (!this.ipLimiter.allow(remote)) throw new RelayError(429, 'rate_limited', `Too many connection attempts: at most ${this.limits.connectsPerMinutePerIp} per minute per address.`);
    if (this.streams.size >= this.limits.maxStreams) {
      this.log.warn('stream_refused', { reason: 'max_streams', streams: this.streams.size });
      throw new RelayError(503, 'too_many_streams', `Relay is at its limit of ${this.limits.maxStreams} concurrent streams; retry later.`);
    }
    const st: Stream = { id: crypto.randomBytes(16).toString('hex'), res, remote, nonce: crypto.randomBytes(32).toString('base64'), closed: false };
    this.streams.set(st.id, st);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    req.socket.setKeepAlive(true, 30_000);
    req.socket.setNoDelay(true);
    const onClose = () => this.onStreamClosed(st);
    res.on('close', onClose);
    res.on('error', onClose);
    st.authTimer = setTimeout(() => {
      if (!st.fingerprint) this.closeStream(st, 'auth_timeout');
    }, this.limits.authTimeoutMs);
    st.authTimer.unref?.();
    st.heartbeat = setInterval(() => this.writeRaw(st, ': ping\n\n'), this.limits.heartbeatMs);
    st.heartbeat.unref?.();
    this.writeEvent(st, 'challenge', { streamId: st.id, nonce: st.nonce });
  }

  private async handleAuth(req: http.IncomingMessage, res: http.ServerResponse, remote: string): Promise<void> {
    if (!this.ipLimiter.allow(remote)) throw new RelayError(429, 'rate_limited', `Too many connection attempts: at most ${this.limits.connectsPerMinutePerIp} per minute per address.`);
    const body = (await this.readJson(req)) as Record<string, unknown> | null;
    const st = body && typeof body.streamId === 'string' ? this.streams.get(body.streamId) : undefined;
    if (!st || st.closed) throw new RelayError(404, 'unknown_stream', 'No open stream with that streamId; open /relay/v1/stream first.');
    if (st.fingerprint) throw new RelayError(409, 'already_authenticated', 'This stream is already authenticated.');
    // One guess per nonce: whatever happens next, the nonce is spent.
    const nonce = st.nonce;
    st.nonce = '';
    const proof = verifyProof({ nonce, claimedFingerprint: body!.fingerprint, certPem: body!.certPem, signature: body!.signature }, this.now());
    if (!proof.ok) {
      this.log.warn('auth_rejected', { reason: proof.reason, remote, claimed: fpPrefix(String(body!.fingerprint ?? '')) });
      this.closeStream(st, 'auth_failed');
      throw new RelayError(401, 'auth_failed', `Identity proof rejected: ${proof.reason}.`);
    }
    const fp = proof.fingerprint;
    if (st.authTimer) clearTimeout(st.authTimer);
    const prev = this.byFingerprint.get(fp);
    if (prev && prev !== st) {
      // A reconnecting agent whose old TCP connection is half dead must be able
      // to take over. Safe: the newcomer just proved it holds the key.
      this.writeEvent(prev, 'replaced', { reason: 'a newer stream authenticated as this identity' });
      this.closeStream(prev, 'replaced');
    }
    st.fingerprint = fp;
    st.session = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(st.session, st);
    this.byFingerprint.set(fp, st);
    this.log.info('agent_connected', { agent: fpPrefix(fp), remote, queued: this.queues.get(fp)?.length ?? 0 });
    this.sendJson(res, 200, { session: st.session, fingerprint: fp });
    this.writeEvent(st, 'ready', { fingerprint: fp });
    // Current membership of each of its rooms, before any queued mail, so an
    // agent that missed join/leave events while offline resynchronises.
    for (const room of this.agentRooms.get(fp) ?? []) this.writeEvent(st, 'room_snapshot', { room, members: [...(this.rooms.get(room) ?? [])] });
    this.flush(fp);
  }

  private onStreamClosed(st: Stream): void {
    if (st.closed) return;
    st.closed = true;
    if (st.authTimer) clearTimeout(st.authTimer);
    if (st.heartbeat) clearInterval(st.heartbeat);
    this.streams.delete(st.id);
    if (st.session) this.sessions.delete(st.session);
    if (!st.fingerprint) return;
    const fp = st.fingerprint;
    if (this.byFingerprint.get(fp) === st) this.byFingerprint.delete(fp);
    // Anything written to this stream but not yet answered may never have
    // arrived. Put it back at the FRONT of the queue (original order) so it is
    // redelivered on reconnect, and release any sender still waiting on it.
    const back: QueueItem[] = [];
    for (const [k, f] of this.inflight) {
      if (f.streamId !== st.id) continue;
      this.inflight.delete(k);
      back.push({ kind: 'message', env: f.env, enqueuedAt: f.enqueuedAt });
      const p = this.pending.get(k);
      if (p) {
        this.pending.delete(k);
        clearTimeout(p.timer);
        p.resolve({ status: 202, body: { status: 'queued', msgId: f.env.msgId, reason: 'Recipient disconnected before replying; it will be redelivered when they reconnect.' } });
      }
    }
    // Room posts written but not acked are redelivered the same way - unless
    // the member has since left the room (they are no longer entitled to it).
    for (const [k, f] of this.roomInflight) {
      if (f.streamId !== st.id) continue;
      this.roomInflight.delete(k);
      if (this.rooms.get(f.room)?.has(fp)) back.push({ kind: 'room', env: f.env, enqueuedAt: f.enqueuedAt });
    }
    if (back.length) {
      back.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      const q = this.queues.get(fp) ?? [];
      q.unshift(...back);
      this.queues.set(fp, q);
    }
    this.log.info('agent_disconnected', { agent: fpPrefix(fp), requeued: back.length });
    // A newer stream may already hold this identity (replacement): hand it the requeued mail.
    if (back.length && this.byFingerprint.has(fp)) this.flush(fp);
  }

  private closeStream(st: Stream, reason: string): void {
    if (st.closed) return;
    if (!st.fingerprint) this.log.info('stream_closed', { reason, remote: st.remote });
    try {
      st.res.end();
    } catch {
      /* ignore */
    }
    st.res.destroy();
    this.onStreamClosed(st);
  }

  private writeRaw(st: Stream, chunk: string): boolean {
    if (st.closed || st.res.destroyed || st.res.writableEnded) return false;
    try {
      st.res.write(chunk);
      return true;
    } catch {
      return false;
    }
  }

  private writeEvent(st: Stream, event: string, data: unknown): boolean {
    return this.writeRaw(st, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private liveStream(fp: string): Stream | undefined {
    const st = this.byFingerprint.get(fp);
    return st && !st.closed && !st.res.destroyed ? st : undefined;
  }

  // ---- send / reply ----------------------------------------------------------

  private async handleSend(env: RelayEnvelope): Promise<SendResult> {
    const key = inflightKey(env.from, env.msgId);
    if (this.inflight.has(key) || this.pending.has(key) || this.isQueued(env.to, env.from, env.msgId)) {
      throw new RelayError(409, 'duplicate_msg_id', 'A message with this msgId from you is already queued or awaiting a reply.');
    }
    this.sweepDestination(env.to);
    const st = this.liveStream(env.to);
    if (!st) {
      this.enqueueOrReject(env.to, { kind: 'message', env, enqueuedAt: this.now() }, env);
      this.log.info('queued', { from: fpPrefix(env.from), to: fpPrefix(env.to), msg: shortId(env.msgId), bytes: env.ct.length });
      return { status: 202, body: { status: 'queued', msgId: env.msgId } };
    }
    this.checkBound(env.to, env);
    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve({ status: 202, body: { status: 'awaiting_reply', msgId: env.msgId, reason: 'Delivered; the reply will arrive on your stream as a "reply" event.' } });
      }, this.limits.replyTimeoutMs);
      timer.unref?.();
      this.pending.set(key, { resolve, timer });
      this.inflight.set(key, { env, enqueuedAt: this.now(), streamId: st.id });
      this.writeEvent(st, 'envelope', env);
      this.log.info('delivered', { from: fpPrefix(env.from), to: fpPrefix(env.to), msg: shortId(env.msgId), bytes: env.ct.length });
    });
  }

  private handleReply(env: RelayEnvelope): SendResult {
    // env.from = the replier (the original recipient); env.to = the original sender.
    const key = inflightKey(env.to, env.msgId);
    const f = this.inflight.get(key);
    if (!f || f.env.to !== env.from) {
      throw new RelayError(404, 'unknown_msg', 'No delivered message with that msgId is awaiting your reply (already answered, expired, or never sent to you).');
    }
    this.inflight.delete(key);
    const p = this.pending.get(key);
    if (p) {
      this.pending.delete(key);
      clearTimeout(p.timer);
      p.resolve({ status: 200, body: { status: 'delivered', reply: env } });
      this.log.info('replied', { from: fpPrefix(env.from), to: fpPrefix(env.to), msg: shortId(env.msgId), path: 'held_request' });
      return { status: 200, body: { status: 'delivered' } };
    }
    const st = this.liveStream(env.to);
    if (st) {
      this.writeEvent(st, 'reply', env);
      this.log.info('replied', { from: fpPrefix(env.from), to: fpPrefix(env.to), msg: shortId(env.msgId), path: 'stream' });
      return { status: 200, body: { status: 'delivered' } };
    }
    this.enqueueOrReject(env.to, { kind: 'reply', env, enqueuedAt: this.now() }, env);
    this.log.info('replied', { from: fpPrefix(env.from), to: fpPrefix(env.to), msg: shortId(env.msgId), path: 'queued' });
    return { status: 202, body: { status: 'queued' } };
  }

  private isQueued(dest: string, sender: string, msgId: string): boolean {
    return (this.queues.get(dest) ?? []).some((i) => i.kind === 'message' && i.env.from === sender && i.env.msgId === msgId);
  }

  private countFor(dest: string): number {
    let n = 0;
    for (const i of this.queues.get(dest) ?? []) if (i.kind !== 'notice') n++;
    for (const f of this.inflight.values()) if (f.env.to === dest) n++;
    for (const f of this.roomInflight.values()) if (f.member === dest) n++;
    return n;
  }

  /** Per-destination and global bounds. Rejecting IS the report to the sender. */
  private checkBound(dest: string, env: RelayEnvelope): void {
    if (this.countFor(dest) >= this.limits.maxQueuedPerDestination) {
      this.log.warn('dropped', { reason: 'queue_full', from: fpPrefix(env.from), to: fpPrefix(dest), msg: shortId(env.msgId) });
      throw new RelayError(507, 'queue_full', `Recipient's queue is full (${this.limits.maxQueuedPerDestination} undelivered messages); message dropped. Retry later.`);
    }
    if (this.stats().queued >= this.limits.maxQueuedTotal) {
      this.log.warn('dropped', { reason: 'relay_full', from: fpPrefix(env.from), to: fpPrefix(dest), msg: shortId(env.msgId) });
      throw new RelayError(507, 'relay_full', 'Relay storage is full; message dropped. Retry later.');
    }
  }

  private enqueueOrReject(dest: string, item: QueueItem, env: RelayEnvelope): void {
    this.checkBound(dest, env);
    const q = this.queues.get(dest) ?? [];
    q.push(item);
    this.queues.set(dest, q);
  }

  /** Deliver a destination's queue to its stream, in order. */
  private flush(fp: string): void {
    this.sweepDestination(fp);
    const q = this.queues.get(fp);
    if (!q || !q.length) return;
    let sent = 0;
    while (q.length) {
      const st = this.liveStream(fp);
      if (!st) break; // stream died mid-flush: the rest stays queued
      const item = q[0];
      let ok: boolean;
      if (item.kind === 'message') {
        // Mark in flight BEFORE writing, so a death right after the write requeues it.
        this.inflight.set(inflightKey(item.env.from, item.env.msgId), { env: item.env, enqueuedAt: item.enqueuedAt, streamId: st.id });
        ok = this.writeEvent(st, 'envelope', item.env);
        if (!ok) this.inflight.delete(inflightKey(item.env.from, item.env.msgId));
      } else if (item.kind === 'room') {
        const room = roomOfAddress(item.env.to)!;
        const k = roomInflightKey(fp, room, item.env.from, item.env.msgId);
        this.roomInflight.set(k, { env: item.env, member: fp, room, enqueuedAt: item.enqueuedAt, streamId: st.id });
        ok = this.writeEvent(st, 'envelope', item.env);
        if (!ok) this.roomInflight.delete(k);
      } else if (item.kind === 'reply') {
        ok = this.writeEvent(st, 'reply', item.env);
      } else {
        ok = this.writeEvent(st, 'dropped', item.notice);
      }
      if (!ok) break;
      q.shift();
      sent++;
    }
    if (!q.length) this.queues.delete(fp);
    if (sent) this.log.info('flushed', { agent: fpPrefix(fp), count: sent, remaining: q.length });
  }

  // ---- rooms (DESIGN.md 11b; see the file-top comment) ------------------------

  private joinRoom(fp: string, room: string): SendResult {
    let members = this.rooms.get(room);
    if (members?.has(fp)) return { status: 200, body: { room, members: [...members], joined: false } }; // idempotent
    const mine = this.agentRooms.get(fp) ?? new Set<string>();
    if (mine.size >= this.limits.maxRoomsPerAgent) {
      this.log.warn('room_refused', { reason: 'too_many_rooms', agent: fpPrefix(fp), room: roomPrefix(room) });
      throw new RelayError(409, 'too_many_rooms', `You are already in ${this.limits.maxRoomsPerAgent} rooms, the most one agent may join; leave one first.`);
    }
    if (members && members.size >= this.limits.maxMembersPerRoom) {
      this.log.warn('room_refused', { reason: 'room_full', agent: fpPrefix(fp), room: roomPrefix(room) });
      throw new RelayError(409, 'room_full', `This room already has ${this.limits.maxMembersPerRoom} members, the most a room may have.`);
    }
    if (!members && this.rooms.size >= this.limits.maxRooms) {
      this.log.warn('room_refused', { reason: 'relay_rooms_full', agent: fpPrefix(fp), room: roomPrefix(room) });
      throw new RelayError(507, 'relay_rooms_full', `Relay is at its limit of ${this.limits.maxRooms} rooms; retry later.`);
    }
    if (!members) {
      members = new Set<string>();
      this.rooms.set(room, members);
    }
    members.add(fp);
    mine.add(room);
    this.agentRooms.set(fp, mine);
    this.log.info('room_joined', { room: roomPrefix(room), agent: fpPrefix(fp), members: members.size });
    this.memberEvent(room, fp, 'joined');
    return { status: 200, body: { room, members: [...members], joined: true } };
  }

  private leaveRoom(fp: string, room: string): SendResult {
    const members = this.rooms.get(room);
    if (!members?.has(fp)) throw new RelayError(404, 'not_a_member', 'You are not a member of that room.');
    members.delete(fp);
    if (!members.size) this.rooms.delete(room);
    const mine = this.agentRooms.get(fp);
    mine?.delete(room);
    if (mine && !mine.size) this.agentRooms.delete(fp);
    // Stop delivery now: discard this member's undelivered and unacked copies of
    // the room's posts. Their senders are not told - the member chose to leave.
    const address = ROOM_ADDRESS_PREFIX + room;
    let purged = 0;
    const q = this.queues.get(fp);
    if (q) {
      const keep = q.filter((i) => !(i.kind === 'room' && i.env.to === address));
      purged += q.length - keep.length;
      if (keep.length) this.queues.set(fp, keep);
      else this.queues.delete(fp);
    }
    for (const [k, f] of [...this.roomInflight]) {
      if (f.member === fp && f.room === room) {
        this.roomInflight.delete(k);
        purged++;
      }
    }
    this.log.info('room_left', { room: roomPrefix(room), agent: fpPrefix(fp), members: members.size, purged });
    this.memberEvent(room, fp, 'left');
    return { status: 200, body: { room, left: true } };
  }

  /** Tell the room's other ONLINE members. Offline members get a `room_snapshot` when they reconnect instead. */
  private memberEvent(room: string, who: string, change: 'joined' | 'left'): void {
    for (const m of this.rooms.get(room) ?? []) {
      if (m === who) continue;
      const st = this.liveStream(m);
      if (st) this.writeEvent(st, 'room_member', { room, fingerprint: who, change });
    }
  }

  private handleRoomPost(room: string, env: RelayEnvelope): SendResult {
    const members = this.rooms.get(room);
    if (!members?.has(env.from)) {
      throw new RelayError(403, 'not_a_member', 'You are not a member of that room; POST /relay/v1/rooms/join first.');
    }
    for (const m of members) {
      if (m === env.from) continue;
      if (this.roomInflight.has(roomInflightKey(m, room, env.from, env.msgId)) || (this.queues.get(m) ?? []).some((i) => i.kind === 'room' && i.env.to === env.to && i.env.from === env.from && i.env.msgId === env.msgId)) {
        throw new RelayError(409, 'duplicate_msg_id', 'A post with this msgId from you to this room is still undelivered or unacknowledged.');
      }
    }
    let delivered = 0;
    let queued = 0;
    const dropped: Array<{ to: string; reason: string }> = [];
    const now = this.now();
    for (const m of members) {
      if (m === env.from) continue; // the sender never gets its own post back
      this.sweepDestination(m);
      // Bounds per member: one full mailbox must not stop the others getting it.
      try {
        this.checkBound(m, env);
      } catch (e) {
        if (!(e instanceof RelayError)) throw e;
        dropped.push({ to: m, reason: e.code });
        continue;
      }
      const st = this.liveStream(m);
      if (st && !this.queues.get(m)?.length) {
        const k = roomInflightKey(m, room, env.from, env.msgId);
        this.roomInflight.set(k, { env, member: m, room, enqueuedAt: now, streamId: st.id });
        if (this.writeEvent(st, 'envelope', env)) {
          delivered++;
          continue;
        }
        this.roomInflight.delete(k);
      }
      const q = this.queues.get(m) ?? [];
      q.push({ kind: 'room', env, enqueuedAt: now });
      this.queues.set(m, q);
      queued++;
      if (st) this.flush(m);
    }
    this.log.info('room_posted', { room: roomPrefix(room), from: fpPrefix(env.from), msg: shortId(env.msgId), bytes: env.ct.length, delivered, queued, dropped: dropped.length });
    if (dropped.length && !delivered && !queued) {
      throw new RelayError(507, dropped.every((d) => d.reason === 'relay_full') ? 'relay_full' : 'queue_full', `No member could accept the post (${dropped.length} full); message dropped. Retry later.`);
    }
    return { status: 202, body: { status: 'posted', msgId: env.msgId, delivered, queued, dropped } };
  }

  private handleAck(fp: string, body: unknown): SendResult {
    const a = parseAckBody(body);
    const k = roomInflightKey(fp, a.room, a.sender, a.msgId);
    if (!this.roomInflight.delete(k)) {
      throw new RelayError(404, 'unknown_msg', 'No room post with that room, sender and msgId is awaiting your acknowledgement (already acked, expired, or never delivered to you).');
    }
    return { status: 200, body: { status: 'acked' } };
  }

  // ---- expiry and drop reporting --------------------------------------------

  /** Drop anything older than the TTL and tell its sender. Runs every minute, and on demand. */
  sweep(): void {
    for (const dest of [...this.queues.keys()]) this.sweepDestination(dest);
    const cutoff = this.now() - this.limits.queueTtlMs;
    for (const [k, f] of [...this.inflight]) {
      if (f.enqueuedAt > cutoff) continue;
      this.inflight.delete(k);
      this.log.warn('dropped', { reason: 'expired_unanswered', from: fpPrefix(f.env.from), to: fpPrefix(f.env.to), msg: shortId(f.env.msgId) });
      this.notify(f.env.from, { msgId: f.env.msgId, to: f.env.to, reason: 'expired: delivered but never answered within the relay TTL' });
    }
    for (const [k, f] of [...this.roomInflight]) {
      if (f.enqueuedAt > cutoff) continue;
      this.roomInflight.delete(k);
      this.log.warn('dropped', { reason: 'expired_unacked', room: roomPrefix(f.room), from: fpPrefix(f.env.from), to: fpPrefix(f.member), msg: shortId(f.env.msgId) });
      this.notify(f.env.from, { msgId: f.env.msgId, to: f.member, room: f.room, reason: 'expired: delivered to this room member but never acknowledged within the relay TTL' });
    }
  }

  private sweepDestination(dest: string): void {
    const q = this.queues.get(dest);
    if (!q) return;
    const cutoff = this.now() - this.limits.queueTtlMs;
    const keep: QueueItem[] = [];
    const expired: QueueItem[] = [];
    for (const i of q) (i.enqueuedAt <= cutoff ? expired : keep).push(i);
    if (!expired.length) return;
    if (keep.length) this.queues.set(dest, keep);
    else this.queues.delete(dest);
    for (const i of expired) {
      if (i.kind === 'notice') {
        this.log.warn('notice_expired', { agent: fpPrefix(dest), msg: shortId(i.notice.msgId) });
        continue;
      }
      const room = i.kind === 'room' ? roomOfAddress(i.env.to)! : undefined;
      this.log.warn('dropped', { reason: 'expired', kind: i.kind, room: room ? roomPrefix(room) : undefined, from: fpPrefix(i.env.from), to: fpPrefix(dest), msg: shortId(i.env.msgId) });
      this.notify(i.env.from, { msgId: i.env.msgId, to: dest, ...(room ? { room } : {}), reason: `expired: recipient did not connect within ${Math.round(this.limits.queueTtlMs / 3_600_000)}h` });
    }
  }

  private notify(sender: string, notice: DropNotice): void {
    const st = this.liveStream(sender);
    if (st && this.writeEvent(st, 'dropped', notice)) return;
    const q = this.queues.get(sender) ?? [];
    if (q.filter((i) => i.kind === 'notice').length >= this.limits.maxNoticesPerAgent) {
      this.log.warn('notice_dropped', { agent: fpPrefix(sender), msg: shortId(notice.msgId) });
      return;
    }
    q.push({ kind: 'notice', notice, enqueuedAt: this.now() });
    this.queues.set(sender, q);
  }

  // ---- http helpers ----------------------------------------------------------

  private readJson(req: http.IncomingMessage): Promise<unknown> {
    const max = this.limits.maxEnvelopeBytes;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      return Promise.reject(new RelayError(413, 'too_large', `Envelope exceeds the ${max}-byte limit.`));
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > max) {
          done = true;
          req.resume();
          reject(new RelayError(413, 'too_large', `Envelope exceeds the ${max}-byte limit.`));
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new RelayError(400, 'bad_json', 'Body is not valid JSON.'));
        }
      });
      req.on('error', (e) => {
        if (!done) {
          done = true;
          reject(e);
        }
      });
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    if (res.headersSent || res.destroyed) return;
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
    res.end(s);
  }

  private sendError(res: http.ServerResponse, e: unknown): void {
    if (e instanceof RelayError) return this.sendJson(res, e.status, { error: { code: e.code, message: e.message } });
    // Never echo an unexpected error's text: it could quote request content.
    this.log.error('internal_error', { kind: e instanceof Error ? e.name : typeof e });
    this.sendJson(res, 500, { error: { code: 'internal', message: 'Internal relay error.' } });
  }
}
