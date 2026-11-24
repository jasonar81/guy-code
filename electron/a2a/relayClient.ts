/**
 * Client side of the A2A relay (docs/a2a/DESIGN.md 11a, step 3 of 3).
 *
 * WHY: on a Fortinet-style SSL VPN no laptop can accept a connection, so an
 * agent holds ONE outbound Server-Sent-Events stream to the relay and receives
 * work over it; everything it sends is an ordinary outbound POST. The relay
 * is untrusted: every request and every reply is sealed end to end with
 * relayCrypto.ts before it leaves this process, and the relay only ever sees
 * {to, from, msgId, iv, ct, tag}.
 *
 * Protocol (relay/README.md):
 *   GET  /relay/v1/stream  -> event `challenge` {streamId, nonce}
 *   POST /relay/v1/auth    {streamId, fingerprint, certPem, signature} -> {session}
 *                          then event `ready`, then any queued mail
 *   POST /relay/v1/send    envelope -> 200 {reply} | 202 awaiting_reply | 202 queued
 *   POST /relay/v1/reply   the sealed response to an `envelope` event
 *   events: envelope, reply, dropped, replaced
 *
 * Delivery is at-least-once: the relay redelivers an envelope whose stream
 * died before the reply. We remember every (sender, msgId) we have seen and
 * never run the same one twice; a repeat after we answered just re-posts the
 * cached (already sealed) reply.
 *
 * PAIRING THROUGH THE RELAY. Two laptops that have never met cannot derive the
 * pair key: the inviter does not know the redeemer's certificate yet. So a
 * pairing request (msgId prefix `p-`) carries the sender's public key IN
 * FRONT of the ciphertext: ct = base64(u16 len || SPKI DER || AES-GCM ct).
 * The relay never decodes ct, and the key is public anyway (the relay sees
 * every agent's certificate at login). The inviter derives the same ECDH key
 * from it and the relay-proven `from` fingerprint; acceptPair then checks the
 * certificate inside the sealed request hashes to that fingerprint, and we
 * check it carries that same public key. Only the card and /a2a-pair may be
 * asked for this way.
 *
 * Relay TLS: pinned by SHA-256 like a peer (connectPinned). With no pin
 * configured the first certificate seen is pinned and reported through
 * onPinLearned so the caller can save it (trust on first use). http:// relays
 * are accepted for trials and tests: payloads are still sealed, but the
 * session token and metadata are not.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { CertPinMismatchError, connectPinned, fingerprintOfDer, normaliseFingerprint } from './tls';
import { deriveRelayKeyFromPublicKey, openEnvelope, sealEnvelope, type RelayPayload, type SealedEnvelope } from './relayCrypto';

/** The exact bytes signed for a relay challenge (relay/src/identity.ts authMessage). */
export const RELAY_AUTH_CONTEXT = 'a2a-relay-auth-v1';

export function signRelayChallenge(nonce: string, privateKeyPem: string): string {
  return crypto.sign('sha256', Buffer.from(`${RELAY_AUTH_CONTEXT}\n${nonce}`, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export const PAIRING_MSG_PREFIX = 'p-';
const MESSAGE_MSG_PREFIX = 'm-';

export type RelayState = 'connected' | 'connecting' | 'disconnected';

export interface RelayStatus {
  state: RelayState;
  url: string;
  lastError: string | null;
  connectedSince: number | null;
  /** Pinned relay certificate (https only). */
  relayCertSha256: string | null;
}

/** The decrypted response we send back for an inbound request. */
export interface RelayResponse {
  status: number;
  body?: unknown;
}

export interface RelayInbound {
  /** Sender fingerprint, proven to the relay by signature. */
  from: string;
  payload: RelayPayload;
  /** True for a `p-` pairing request from someone we may not know yet. */
  pairing: boolean;
}

export interface RelayDropNotice {
  msgId: string;
  to: string;
  reason: string;
}

export interface RelayClientOptions {
  url: string;
  identity: { certPem: string; keyPem: string; fingerprint: string };
  relayCertSha256?: string | null;
  onPinLearned?(fingerprint: string): void;
  /** Pair key for a sender we are paired with, or null. */
  keyFor(fromFingerprint: string): Buffer | null;
  /** The SAME request handler the HTTPS server uses (A2AServer.handleRelayed). */
  handle(req: RelayInbound): Promise<RelayResponse>;
  onDropped?(n: RelayDropNotice): void;
  onStatus?(s: RelayStatus): void;
  /** Called each time the stream (re)authenticates: a good moment to flush the outbox. */
  onReady?(): void;
  /**
   * A room post (design 11b): `to` was "room:<id>". There is no reply; the
   * handler must call `ackRoom` (rooms.ts does, for every post, including the
   * ones it drops) or the relay redelivers it when this stream dies.
   */
  onRoomEnvelope?(env: RoomEnvelope): void | Promise<void>;
  /** `room_member` / `room_snapshot` events (informational; the roster is end to end). */
  onRoomEvent?(event: 'room_member' | 'room_snapshot', data: Record<string, unknown>): void;
  /** How long a caller waits for a reply after the relay said 202. Default 30 s. */
  replyWaitMs?: number;
  backoff?: { baseMs: number; maxMs: number };
  /** No bytes (not even the relay's 15 s heartbeat) for this long = dead stream. Default 45 s. */
  staleMs?: number;
  log?: { info(...a: unknown[]): void; warn(...a: unknown[]): void };
}

/** A room post as it arrives: the relay-proven sender, the room, and the sealed bytes. */
export interface RoomEnvelope extends SealedEnvelope {
  room: string;
  from: string;
  msgId: string;
}

/** The relay's answer to a room post. */
export interface RoomPostResult {
  delivered: number;
  queued: number;
  dropped: Array<{ to: string; reason: string }>;
}

export const ROOM_ADDRESS_PREFIX = 'room:';

/** The relay accepted the message but reports it was never delivered (TTL, never answered). */
export class RelayDroppedError extends Error {
  constructor(readonly notice: RelayDropNotice) {
    super(`Not delivered: the relay dropped the message (${notice.reason}).`);
    this.name = 'RelayDroppedError';
  }
}

/** Relay-level failure that is worth retrying later (down, full, rate limited, not connected). */
export class RelayUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayUnavailableError';
  }
}

interface Waiter {
  key: Buffer;
  resolve(r: RelayResponse): void;
  reject(e: Error): void;
}

const MAX_SEEN = 2000;
/** A direct attempt that just failed is not retried for this long while the relay works. */
const DIRECT_SKIP_MS = 2 * 60_000;

export class RelayClient {
  private stateV: RelayState = 'disconnected';
  private lastError: string | null = null;
  private connectedSince: number | null = null;
  private pin: string | null;
  private session: string | null = null;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private streamReq: http.ClientRequest | null = null;
  private streamRes: http.IncomingMessage | null = null;
  private generation = 0;
  private readonly waiters = new Map<string, Waiter>();
  /** `${from}|${msgId}` -> 'busy' while handling, then the sealed reply we sent. */
  private readonly seen = new Map<string, 'busy' | Record<string, string>>();
  private readonly directDown = new Map<string, number>();
  private readonly base: URL;
  private readonly me: string;

  constructor(private readonly opts: RelayClientOptions) {
    this.base = new URL(opts.url);
    if (this.base.protocol !== 'https:' && this.base.protocol !== 'http:') throw new Error('The relay URL must start with https:// (or http:// for a trial).');
    this.pin = opts.relayCertSha256 ? normaliseFingerprint(opts.relayCertSha256) : null;
    this.me = normaliseFingerprint(opts.identity.fingerprint);
  }

  get url(): string {
    return this.opts.url;
  }

  get fingerprint(): string {
    return this.me;
  }

  status(): RelayStatus {
    return { state: this.stateV, url: this.opts.url, lastError: this.lastError, connectedSince: this.connectedSince, relayCertSha256: this.pin };
  }

  isConnected(): boolean {
    return this.stateV === 'connected' && !!this.session;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardownStream();
    for (const [id, w] of this.waiters) {
      this.waiters.delete(id);
      w.reject(new RelayUnavailableError('The relay connection was closed.'));
    }
    this.setState('disconnected');
  }

  /** Was a direct attempt to this origin unreachable in the last two minutes? */
  directRecentlyDown(origin: string): boolean {
    const t = this.directDown.get(origin);
    if (t === undefined) return false;
    if (Date.now() - t > DIRECT_SKIP_MS) {
      this.directDown.delete(origin);
      return false;
    }
    return true;
  }

  noteDirectDown(origin: string): void {
    this.directDown.set(origin, Date.now());
    if (this.directDown.size > 1000) this.directDown.clear();
  }

  /** Simulate a dropped connection (tests, and "reconnect now" from the UI). */
  dropConnection(): void {
    if (this.stopped) return;
    this.fail(this.generation, 'connection dropped');
  }

  // ---- outbound ----------------------------------------------------------------

  /**
   * Send one sealed request to `to` and wait for the sealed reply. `pairing`
   * puts our public key in front of the ciphertext (see the file comment).
   */
  async request(to: string, key: Buffer, payload: RelayPayload, opts: { pairing?: boolean } = {}): Promise<RelayResponse> {
    if (!this.isConnected()) throw new RelayUnavailableError(`The relay is not connected${this.lastError ? ` (${this.lastError})` : ''}.`);
    const msgId = (opts.pairing ? PAIRING_MSG_PREFIX : MESSAGE_MSG_PREFIX) + crypto.randomBytes(18).toString('base64url');
    const sealed = sealEnvelope(key, payload);
    const ct = opts.pairing ? withPublicKeyPrefix(this.opts.identity.certPem, sealed.ct) : sealed.ct;
    const env = { to: normaliseFingerprint(to), from: this.me, msgId, iv: sealed.iv, ct, tag: sealed.tag };
    const wait = this.registerWaiter(msgId, key);
    let r: { status: number; body: any };
    try {
      r = await this.post('/relay/v1/send', env, (this.opts.replyWaitMs ?? 30_000) + 15_000);
    } catch (e) {
      this.waiters.delete(msgId);
      wait.promise.catch(() => {});
      throw e;
    }
    if (r.status === 200 && r.body?.reply) {
      this.waiters.delete(msgId);
      wait.promise.catch(() => {});
      return openEnvelope<RelayResponse>(key, r.body.reply as SealedEnvelope);
    }
    if (r.status === 202 && r.body?.status === 'queued') {
      // The peer is not connected. The relay holds the message and delivers it
      // when they connect; we do not block the caller on that. Its answer, if
      // it arrives later, has no waiter and is ignored: the caller's outbox
      // retries with the same A2A messageId and the peer deduplicates it.
      this.waiters.delete(msgId);
      wait.promise.catch(() => {});
      throw new RelayUnavailableError('The peer is not connected to the relay right now; the relay is holding the message and will deliver it when they connect.');
    }
    if (r.status === 202) {
      // awaiting_reply: delivered, the answer comes later as a `reply` event.
      const ms = this.opts.replyWaitMs ?? 30_000;
      return await new Promise<RelayResponse>((resolve, reject) => {
        const t = setTimeout(() => {
          this.waiters.delete(msgId);
          reject(new RelayUnavailableError(`The peer received the message through the relay but has not answered within ${Math.round(ms / 1000)}s.`));
        }, ms);
        t.unref?.();
        wait.promise.then(
          (v) => {
            clearTimeout(t);
            resolve(v);
          },
          (e) => {
            clearTimeout(t);
            reject(e);
          }
        );
      });
    }
    this.waiters.delete(msgId);
    wait.promise.catch(() => {});
    const code = String(r.body?.error?.code ?? '');
    const msg = String(r.body?.error?.message ?? `HTTP ${r.status}`);
    if (r.status === 401) {
      // Our session died with its stream: reconnect, and let the caller retry.
      this.dropConnection();
      throw new RelayUnavailableError(`The relay session expired; reconnecting (${msg}).`);
    }
    if (r.status >= 500 || r.status === 429) throw new RelayUnavailableError(`Relay refused the message: ${code || r.status} - ${msg}`);
    throw new Error(`Relay rejected the message: ${code || r.status} - ${msg}`);
  }

  // ---- rooms (design 11b) -----------------------------------------------------------

  /** POST a rooms call ({room} join / leave, or an ack). Throws RelayUnavailableError / Error. */
  private async roomCall(path: string, body: Record<string, string>): Promise<any> {
    if (!this.isConnected()) throw new RelayUnavailableError(`The relay is not connected${this.lastError ? ` (${this.lastError})` : ''}.`);
    const r = await this.post(path, body, 15_000);
    if (r.status === 200) return r.body;
    const msg = String(r.body?.error?.message ?? `HTTP ${r.status}`);
    if (r.status === 401) {
      this.dropConnection();
      throw new RelayUnavailableError(`The relay session expired; reconnecting (${msg}).`);
    }
    if (r.status >= 500 || r.status === 429) throw new RelayUnavailableError(`Relay refused: ${msg}`);
    throw Object.assign(new Error(`Relay refused: ${msg}`), { status: r.status, code: r.body?.error?.code });
  }

  /** Join a room at the relay. Idempotent; the relay forgets rooms on restart, so call it after every login. */
  joinRoom(room: string): Promise<{ members: string[]; joined: boolean }> {
    return this.roomCall('/relay/v1/rooms/join', { room });
  }

  leaveRoom(room: string): Promise<unknown> {
    return this.roomCall('/relay/v1/rooms/leave', { room });
  }

  /** Acknowledge a room post; until then the relay redelivers it if our stream dies. */
  async ackRoom(room: string, sender: string, msgId: string): Promise<void> {
    try {
      await this.roomCall('/relay/v1/ack', { room, sender, msgId });
    } catch (e) {
      // 404 = already acked (or the relay restarted and forgot it): nothing to do.
      if ((e as { status?: number }).status !== 404) throw e;
    }
  }

  /** Post an already sealed (and signed) message to a room: still exactly the six envelope fields. */
  async postRoom(room: string, msgId: string, sealed: SealedEnvelope): Promise<RoomPostResult> {
    if (!this.isConnected()) throw new RelayUnavailableError(`The relay is not connected${this.lastError ? ` (${this.lastError})` : ''}.`);
    const env = { to: ROOM_ADDRESS_PREFIX + room, from: this.me, msgId, iv: sealed.iv, ct: sealed.ct, tag: sealed.tag };
    const r = await this.post('/relay/v1/send', env, 15_000);
    if (r.status === 202 && r.body?.status === 'posted') {
      return { delivered: Number(r.body.delivered ?? 0), queued: Number(r.body.queued ?? 0), dropped: Array.isArray(r.body.dropped) ? r.body.dropped : [] };
    }
    const msg = String(r.body?.error?.message ?? `HTTP ${r.status}`);
    if (r.status === 401) {
      this.dropConnection();
      throw new RelayUnavailableError(`The relay session expired; reconnecting (${msg}).`);
    }
    if (r.status >= 500 || r.status === 429) throw new RelayUnavailableError(`Relay refused the post: ${msg}`);
    throw Object.assign(new Error(`Relay refused the post: ${msg}`), { status: r.status, code: r.body?.error?.code });
  }

  private registerWaiter(msgId: string, key: Buffer): { promise: Promise<RelayResponse> } {
    let resolve!: (r: RelayResponse) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<RelayResponse>((a, b) => {
      resolve = a;
      reject = b;
    });
    this.waiters.set(msgId, { key, resolve, reject });
    return { promise };
  }

  // ---- connection ----------------------------------------------------------------

  private setState(s: RelayState, err?: string | null): void {
    this.stateV = s;
    if (err !== undefined) this.lastError = err;
    if (s === 'connected') this.connectedSince = Date.now();
    else this.connectedSince = null;
    try {
      this.opts.onStatus?.(this.status());
    } catch {
      /* UI nicety */
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.session = null;
    this.setState('connecting');
    try {
      const sock = await this.openSocket(10_000);
      if (gen !== this.generation || this.stopped) {
        sock?.destroy();
        return;
      }
      const req = http.request({
        host: this.host(),
        port: this.port(),
        method: 'GET',
        path: this.path('/relay/v1/stream'),
        headers: { Accept: 'text/event-stream' },
        ...(sock ? { createConnection: () => sock } : { agent: false }),
      });
      this.streamReq = req;
      req.on('response', (res) => {
        if (gen !== this.generation) return void res.destroy();
        this.streamRes = res;
        if (res.statusCode !== 200) {
          res.resume();
          this.fail(gen, `relay refused the stream (HTTP ${res.statusCode})`);
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        this.bumpStale(gen);
        res.on('data', (c: string) => {
          if (gen !== this.generation) return;
          this.bumpStale(gen);
          buf += c.replace(/\r/g, '');
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            this.onBlock(gen, block);
          }
        });
        res.on('end', () => this.fail(gen, 'the relay closed the stream'));
        res.on('error', (e) => this.fail(gen, e.message));
        res.on('close', () => this.fail(gen, 'the relay stream closed'));
      });
      req.on('error', (e) => this.fail(gen, describe(e)));
      req.end();
    } catch (e) {
      this.fail(gen, describe(e));
    }
  }

  private onBlock(gen: number, block: string): void {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return;
    let d: any;
    try {
      d = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    switch (event) {
      case 'challenge':
        void this.answerChallenge(gen, String(d.streamId ?? ''), String(d.nonce ?? ''));
        break;
      case 'ready':
        if (gen !== this.generation || !this.session) return;
        this.attempts = 0;
        this.setState('connected', null);
        this.opts.log?.info('[a2a-relay] connected', this.opts.url);
        try {
          this.opts.onReady?.();
        } catch {
          /* best effort */
        }
        break;
      case 'envelope':
        void this.onEnvelope(d);
        break;
      case 'reply':
        this.onReply(d);
        break;
      case 'dropped':
        this.onDroppedEvent(d);
        break;
      case 'replaced':
        this.fail(gen, 'another connection with this identity replaced this one');
        break;
      case 'room_member':
      case 'room_snapshot':
        try {
          this.opts.onRoomEvent?.(event, d);
        } catch {
          /* informational */
        }
        break;
    }
  }

  private async answerChallenge(gen: number, streamId: string, nonce: string): Promise<void> {
    try {
      const signature = signRelayChallenge(nonce, this.opts.identity.keyPem);
      const r = await this.rawPost('/relay/v1/auth', { streamId, fingerprint: this.me, certPem: this.opts.identity.certPem, signature }, {}, 15_000);
      if (gen !== this.generation) return;
      if (r.status !== 200 || typeof r.body?.session !== 'string') {
        this.fail(gen, `relay login failed: ${r.body?.error?.message ?? `HTTP ${r.status}`}`);
        return;
      }
      this.session = r.body.session;
    } catch (e) {
      this.fail(gen, `relay login failed: ${describe(e)}`);
    }
  }

  private bumpStale(gen: number): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      if (gen === this.generation) {
        this.teardownStream();
        this.fail(gen, 'the relay stream went quiet (no heartbeat)');
      }
    }, this.opts.staleMs ?? 45_000);
    this.staleTimer.unref?.();
  }

  private teardownStream(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = null;
    const req = this.streamReq;
    const res = this.streamRes;
    this.streamReq = null;
    this.streamRes = null;
    this.session = null;
    try {
      res?.destroy();
      req?.destroy();
    } catch {
      /* ignore */
    }
  }

  private fail(gen: number, why: string): void {
    if (gen !== this.generation) return;
    this.generation++; // ignore anything else from that stream
    this.teardownStream();
    this.onStreamGone(why);
  }

  private onStreamGone(why: string): void {
    this.session = null;
    if (this.stopped) {
      this.setState('disconnected');
      return;
    }
    this.opts.log?.warn('[a2a-relay] disconnected:', why);
    this.setState('disconnected', why);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const b = this.opts.backoff ?? { baseMs: 1000, maxMs: 60_000 };
    const exp = Math.min(b.maxMs, b.baseMs * 2 ** Math.min(this.attempts, 16));
    const delay = Math.round(exp * (0.7 + Math.random() * 0.6)); // +-30% jitter
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // ---- inbound ---------------------------------------------------------------------

  private async onEnvelope(env: any): Promise<void> {
    const from = String(env?.from ?? '');
    const msgId = String(env?.msgId ?? '');
    if (!from || !msgId) return;
    const to = String(env?.to ?? '');
    if (to.startsWith(ROOM_ADDRESS_PREFIX)) {
      // A room post: no reply. rooms.ts verifies, stores, delivers and acks.
      const room = to.slice(ROOM_ADDRESS_PREFIX.length);
      if (!this.opts.onRoomEnvelope) {
        void this.ackRoom(room, from, msgId).catch(() => {});
        return;
      }
      try {
        await this.opts.onRoomEnvelope({ room, from, msgId, iv: String(env.iv ?? ''), ct: String(env.ct ?? ''), tag: String(env.tag ?? '') });
      } catch (e) {
        this.opts.log?.warn('[a2a-relay] room post handler failed:', (e as Error).message);
      }
      return;
    }
    const k = `${from}|${msgId}`;
    const seen = this.seen.get(k);
    if (seen === 'busy') return; // a redelivery while we are still working on it
    if (seen) {
      // Already answered, but the relay did not get (or lost) our reply: resend it, do not run it again.
      void this.post('/relay/v1/reply', seen, 15_000).catch(() => {});
      return;
    }
    this.remember(k, 'busy');
    const pairing = msgId.startsWith(PAIRING_MSG_PREFIX);
    let key: Buffer | null = null;
    let payload: RelayPayload;
    try {
      let ct = String(env.ct ?? '');
      let senderKey: crypto.KeyObject | null = null;
      if (pairing) {
        const split = splitPublicKeyPrefix(ct);
        senderKey = split.key;
        ct = split.ct;
        key = deriveRelayKeyFromPublicKey(this.opts.identity.keyPem, senderKey, this.me, from);
      } else {
        key = this.opts.keyFor(from);
      }
      if (!key) {
        this.opts.log?.warn('[a2a-relay] envelope from an unpaired agent ignored', from.slice(0, 12));
        return; // cannot even seal a refusal; the relay reports it dropped after its TTL
      }
      payload = openEnvelope<RelayPayload>(key, { iv: String(env.iv), ct, tag: String(env.tag) });
      if (pairing && senderKey) {
        const refusal = pairingRefusal(payload, senderKey);
        if (refusal) {
          await this.sendReply(from, msgId, key, { status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: refusal } } }, k);
          return;
        }
      }
    } catch (e) {
      this.opts.log?.warn('[a2a-relay] could not open an envelope:', (e as Error).message);
      return;
    }
    let res: RelayResponse;
    try {
      res = await this.opts.handle({ from, payload, pairing });
    } catch (e) {
      res = { status: 500, body: { error: { code: 500, status: 'INTERNAL', message: 'Internal error.' } } };
      this.opts.log?.warn('[a2a-relay] handler failed:', (e as Error).message);
    }
    await this.sendReply(from, msgId, key, res, k);
  }

  private async sendReply(to: string, msgId: string, key: Buffer, res: RelayResponse, seenKey: string): Promise<void> {
    const sealed = sealEnvelope(key, { status: res.status, body: res.body });
    const env = { to, from: this.me, msgId, iv: sealed.iv, ct: sealed.ct, tag: sealed.tag };
    this.remember(seenKey, env);
    try {
      const r = await this.post('/relay/v1/reply', env, 15_000);
      if (r.status >= 300 && r.status !== 404) this.opts.log?.warn('[a2a-relay] reply not accepted:', r.status, r.body?.error?.code);
    } catch (e) {
      // Our stream is probably gone too: the relay will redeliver and we resend the cached reply.
      this.opts.log?.warn('[a2a-relay] reply failed:', describe(e));
    }
  }

  private remember(k: string, v: 'busy' | Record<string, string>): void {
    this.seen.delete(k);
    this.seen.set(k, v);
    while (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
  }

  private onReply(env: any): void {
    const w = this.waiters.get(String(env?.msgId ?? ''));
    if (!w) return; // the caller gave up already; it will retry from its outbox
    this.waiters.delete(String(env.msgId));
    try {
      w.resolve(openEnvelope<RelayResponse>(w.key, env as SealedEnvelope));
    } catch (e) {
      w.reject(e as Error);
    }
  }

  private onDroppedEvent(d: any): void {
    const notice: RelayDropNotice = { msgId: String(d?.msgId ?? ''), to: String(d?.to ?? ''), reason: String(d?.reason ?? 'dropped') };
    this.opts.log?.warn('[a2a-relay] message dropped:', notice.reason);
    const w = this.waiters.get(notice.msgId);
    if (w) {
      this.waiters.delete(notice.msgId);
      w.reject(new RelayDroppedError(notice));
    }
    try {
      this.opts.onDropped?.(notice);
    } catch {
      /* best effort */
    }
  }

  // ---- HTTP to the relay -------------------------------------------------------------

  private host(): string {
    return this.base.hostname.replace(/^\[|\]$/g, '');
  }

  private port(): number {
    return Number(this.base.port) || (this.base.protocol === 'https:' ? 443 : 80);
  }

  private path(p: string): string {
    return this.base.pathname.replace(/\/+$/, '') + p;
  }

  /** A pinned TLS socket for https (TOFU when unpinned), or undefined for http. */
  private async openSocket(timeoutMs: number): Promise<net.Socket | undefined> {
    if (this.base.protocol !== 'https:') return undefined;
    if (this.pin) return connectPinned({ host: this.host(), port: this.port(), fingerprint: this.pin, timeoutMs });
    const sock = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const host = this.host();
      const s = tls.connect({ host, port: this.port(), rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host });
      const t = setTimeout(() => {
        s.destroy();
        reject(Object.assign(new Error('TLS connect to the relay timed out'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      s.once('secureConnect', () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const raw = sock.getPeerCertificate()?.raw;
    if (!raw) {
      sock.destroy();
      throw new Error('The relay presented no certificate.');
    }
    // Pin on first use, and tell the caller so it can save it.
    this.pin = fingerprintOfDer(raw);
    this.opts.log?.info('[a2a-relay] pinned relay certificate', this.pin.slice(0, 16));
    try {
      this.opts.onPinLearned?.(this.pin);
    } catch {
      /* best effort */
    }
    return sock;
  }

  private post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: any }> {
    if (!this.session) return Promise.reject(new RelayUnavailableError('The relay is not connected.'));
    return this.rawPost(path, body, { Authorization: `Bearer ${this.session}` }, timeoutMs);
  }

  private async rawPost(path: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: any }> {
    let sock: net.Socket | undefined;
    try {
      sock = await this.openSocket(Math.min(timeoutMs, 10_000));
    } catch (e) {
      if (e instanceof CertPinMismatchError) throw new RelayUnavailableError(`The relay's TLS certificate changed (${e.message})`);
      throw new RelayUnavailableError(`Cannot reach the relay: ${describe(e)}`);
    }
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host(),
          port: this.port(),
          method: 'POST',
          path: this.path(path),
          headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
          ...(sock ? { createConnection: () => sock! } : { agent: false }),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const s = Buffer.concat(chunks).toString('utf8');
            let parsed: any = {};
            try {
              parsed = s ? JSON.parse(s) : {};
            } catch {
              parsed = {};
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', (e) => reject(new RelayUnavailableError(`Relay connection failed: ${e.message}`)));
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('relay request timed out')));
      req.on('error', (e) => reject(new RelayUnavailableError(`Cannot reach the relay: ${describe(e)}`)));
      req.end(data);
    });
  }
}

function describe(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err instanceof CertPinMismatchError) return `relay certificate changed: ${err.message}`;
  return err?.code ? `${err.code}${err.message && !err.message.includes(err.code) ? ` ${err.message}` : ''}` : String(err?.message ?? e);
}

/** ct for a pairing request: base64(u16 len || our SPKI DER || ciphertext). */
function withPublicKeyPrefix(certPem: string, ctB64: string): string {
  const spki = new crypto.X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(spki.length);
  return Buffer.concat([len, spki, Buffer.from(ctB64, 'base64')]).toString('base64');
}

function splitPublicKeyPrefix(ctB64: string): { key: crypto.KeyObject; ct: string } {
  const buf = Buffer.from(ctB64, 'base64');
  if (buf.length < 3) throw new Error('pairing envelope too short');
  const n = buf.readUInt16BE(0);
  if (n < 32 || n > 512 || buf.length <= 2 + n) throw new Error('pairing envelope has a bad key prefix');
  const key = crypto.createPublicKey({ key: buf.subarray(2, 2 + n), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec') throw new Error('pairing key is not EC');
  return { key, ct: buf.subarray(2 + n).toString('base64') };
}

/**
 * A pairing-format request may only fetch the public card or redeem an
 * invite, and a redemption must carry a certificate with the very key it
 * was sealed with (acceptPair separately checks that cert's fingerprint
 * equals the relay-proven sender).
 */
function pairingRefusal(p: RelayPayload, senderKey: crypto.KeyObject): string | null {
  const path = String(p?.path ?? '').split('?')[0];
  if (p?.method === 'GET' && path === '/.well-known/agent-card.json') return null;
  if (p?.method !== 'POST' || path !== '/a2a-pair') return 'Only pairing is allowed before you are paired.';
  const pem = (p.body as { myCertPem?: unknown } | undefined)?.myCertPem;
  if (typeof pem !== 'string') return 'Pairing through the relay needs myCertPem.';
  try {
    const certKey = new crypto.X509Certificate(pem).publicKey;
    const a = certKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const b = senderKey.export({ type: 'spki', format: 'der' }) as Buffer;
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'myCertPem does not carry the key this request was sealed with.';
  } catch {
    return 'myCertPem is unreadable.';
  }
  return null;
}
