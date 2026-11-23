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
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { isFingerprint, verifyProof } from './identity';
import { RelayLogger, fpPrefix } from './log';

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
  if (!isFingerprint(o.to)) throw new RelayError(400, 'bad_envelope', 'Field "to" must be a lowercase SHA-256 hex certificate fingerprint.');
  if (!isFingerprint(o.from)) throw new RelayError(400, 'bad_envelope', 'Field "from" must be a lowercase SHA-256 hex certificate fingerprint.');
  if (o.to === o.from) throw new RelayError(400, 'bad_envelope', 'An agent cannot send to itself.');
  if (!MSG_ID_RE.test(o.msgId as string)) throw new RelayError(400, 'bad_envelope', 'Field "msgId" must be 1-128 chars of [A-Za-z0-9._:-].');
  if ((o.iv as string).length !== IV_B64_LEN || !BASE64_RE.test(o.iv as string)) throw new RelayError(400, 'bad_envelope', 'Field "iv" must be a base64 12-byte GCM nonce.');
  if ((o.tag as string).length !== TAG_B64_LEN || !BASE64_RE.test(o.tag as string)) throw new RelayError(400, 'bad_envelope', 'Field "tag" must be a base64 16-byte GCM tag.');
  if (!(o.ct as string).length || !BASE64_RE.test(o.ct as string)) throw new RelayError(400, 'bad_envelope', 'Field "ct" must be non-empty base64 ciphertext.');
  // Copy exactly the six fields; never keep a reference to the parsed body.
  return { to: o.to as string, from: o.from as string, msgId: o.msgId as string, iv: o.iv as string, ct: o.ct as string, tag: o.tag as string };
}

type QueueItem =
  | { kind: 'message'; env: RelayEnvelope; enqueuedAt: number }
  | { kind: 'reply'; env: RelayEnvelope; enqueuedAt: number }
  | { kind: 'notice'; notice: DropNotice; enqueuedAt: number };

interface DropNotice {
  msgId: string;
  to: string;
  reason: string;
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
  stats(): { streams: number; agents: number; queued: number; inflight: number } {
    let queued = 0;
    for (const q of this.queues.values()) queued += q.length;
    return { streams: this.streams.size, agents: this.byFingerprint.size, queued, inflight: this.inflight.size };
  }

  /**
   * Everything the relay currently holds, serialised. For tests that assert
   * no plaintext is ever stored; also handy for debugging.
   */
  dumpState(): string {
    return JSON.stringify({
      queues: [...this.queues.entries()],
      inflight: [...this.inflight.entries()],
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
      const r = path === '/relay/v1/send' ? await this.handleSend(env) : this.handleReply(env);
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
    const back: Inflight[] = [];
    for (const [k, f] of this.inflight) {
      if (f.streamId !== st.id) continue;
      this.inflight.delete(k);
      back.push(f);
      const p = this.pending.get(k);
      if (p) {
        this.pending.delete(k);
        clearTimeout(p.timer);
        p.resolve({ status: 202, body: { status: 'queued', msgId: f.env.msgId, reason: 'Recipient disconnected before replying; it will be redelivered when they reconnect.' } });
      }
    }
    if (back.length) {
      back.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
      const q = this.queues.get(fp) ?? [];
      q.unshift(...back.map((f): QueueItem => ({ kind: 'message', env: f.env, enqueuedAt: f.enqueuedAt })));
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
      this.log.warn('dropped', { reason: 'expired', kind: i.kind, from: fpPrefix(i.env.from), to: fpPrefix(dest), msg: shortId(i.env.msgId) });
      this.notify(i.env.from, { msgId: i.env.msgId, to: dest, reason: `expired: recipient did not connect within ${Math.round(this.limits.queueTtlMs / 3_600_000)}h` });
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
