/**
 * Embedded A2A v1.0 server (HTTP+JSON binding) on node:https.
 *
 * Hand-rolled rather than `@a2a-js/sdk` because the SDK's server adapters are
 * Express or gRPC only (design 12a, Q5b). Structure follows chromeWsServer.ts:
 * a small class with idempotent start/stop and real-socket tests on an
 * ephemeral port.
 *
 * Every request goes through the same gate, in this order:
 *   1. CIDR allow-list on the socket's remote address (403). This applies to
 *      the public card too: a host outside the VPN range learns nothing.
 *   2. Public card: GET /.well-known/agent-card.json, no token.
 *   3. /a2a-pair is the only other route without a bearer token; the invite
 *      secret is its credential, and it is rate limited per source address.
 *   4. Everything else: bearer token -> peer (401), blocked peer (403),
 *      A2A-Version must be 1.0 (400), per-peer rate limit (429), then the body
 *      cap (413) while reading.
 *
 * Routes (design 12a confirms the shapes):
 *   GET  /.well-known/agent-card.json  public card
 *   GET  /extendedAgentCard            authenticated card (+ shareable sessions, P2)
 *   POST /message:send                 SendMessage
 *   GET  /tasks                        ListTasks (the caller's own tasks only)
 *   GET  /tasks/{id}                   GetTask
 *   POST /tasks/{id}:cancel            CancelTask
 *   POST /a2a-pair                     pairing extension (design 4.3)
 *   POST /a2a-unpair                   pairing extension: "they unpaired us" (4.3 step 5)
 *   POST /a2a-push                     push receiver for tasks WE created on the caller
 *
 * /a2a-push is a normal authenticated route: the pushing peer presents the
 * same bearer token it uses for everything else, so the gate above has
 * already proved who it is. The handler then checks the per-task token from
 * the X-A2A-Notification-Token header against the hash we stored when we
 * created the task, and that the task is one we created on THAT peer.
 */
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { A2AProtocolError, errors } from './errors';
import { LIMITS, normaliseRemoteAddress, ipInCidrs } from './config';
import type { PeerRow } from './store';
import type { AgentCard, ListTasksResponse, PairRequest, PairResponse, SendMessageRequest, StreamResponse, Task } from './types';
import { A2A_CONTENT_TYPE, A2A_PROTOCOL_VERSION } from './types';

export interface A2AServerHandlers {
  /** Peer for a bearer token, or undefined. */
  authenticate(token: string): PeerRow | undefined;
  /** Effective trust right now (expiry and global pause applied). */
  effectiveTrust(peer: PeerRow): PeerRow['trust'];
  card(): AgentCard;
  extendedCard(peer: PeerRow): AgentCard & Record<string, unknown>;
  sendMessage(peer: PeerRow, req: SendMessageRequest): Promise<Task>;
  getTask(peer: PeerRow, taskId: string): Task;
  cancelTask(peer: PeerRow, taskId: string): Task;
  pair(req: PairRequest, remoteAddress: string): Promise<PairResponse>;
  /** ListTasks: only tasks between us and this peer. */
  listTasks(peer: PeerRow, query: URLSearchParams): ListTasksResponse;
  /** Inbound push for a task we created on this peer. `pushToken` from X-A2A-Notification-Token. */
  push(peer: PeerRow, body: StreamResponse, pushToken: string): { accepted: boolean; result: string };
  /** The peer unpaired us. */
  unpaired(peer: PeerRow): void;
  /** Called once a request has passed auth and the gate (used to flush the outbox early). */
  onPeerSeen?(peer: PeerRow): void;
  /** Called for every rejected request, for the audit log. Never given secrets. */
  onRejected?(info: { route: string; status: number; reason: string; peer?: string; remote: string }): void;
}

export interface A2AServerOptions {
  host: string;
  /** 0 for an ephemeral port (tests). */
  port: number;
  /** PEM cert + key. Omit only with insecureHttp (local tests). */
  tls?: { certPem: string; keyPem: string };
  insecureHttp?: boolean;
  allowCidrs: () => string[];
  handlers: A2AServerHandlers;
  now?: () => number;
}

export interface A2AServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
  /** Scheme + host + port as peers should dial it, e.g. https://10.30.1.23:7427 */
  origin(advertiseHost?: string): string;
}

export function createA2AServer(opts: A2AServerOptions): A2AServer {
  return new A2AServerImpl(opts);
}

/** Fixed one-minute window per key. Coarse, but cheap and good enough for 60/min. */
class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly max: number,
    private readonly now: () => number
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.windows.clear(); // bound memory under a flood of keys
      return true;
    }
    w.count++;
    return w.count <= this.max;
  }
}

class A2AServerImpl implements A2AServer {
  private server: http.Server | https.Server | null = null;
  private actualPort = 0;
  private readonly now: () => number;
  private readonly peerLimiter: RateLimiter;
  private readonly pairLimiter: RateLimiter;

  constructor(private readonly opts: A2AServerOptions) {
    this.now = opts.now ?? Date.now;
    this.peerLimiter = new RateLimiter(LIMITS.requestsPerMinutePerPeer, this.now);
    this.pairLimiter = new RateLimiter(LIMITS.pairAttemptsPerMinutePerIp, this.now);
  }

  port(): number {
    return this.actualPort;
  }

  origin(advertiseHost?: string): string {
    const host = advertiseHost || this.opts.host;
    const h = host.includes(':') ? `[${host}]` : host;
    return `${this.opts.insecureHttp ? 'http' : 'https'}://${h}:${this.actualPort}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handle(req, res).catch((e) => this.sendError(res, e));
    };
    let server: http.Server | https.Server;
    if (this.opts.insecureHttp) {
      server = http.createServer(handler);
    } else {
      if (!this.opts.tls) throw new Error('A2A server needs a TLS identity unless insecureHttp is set');
      server = https.createServer({ cert: this.opts.tls.certPem, key: this.opts.tls.keyPem, minVersion: 'TLSv1.2' }, handler);
    }
    // Slow-loris guard: a peer has 30s to send its headers and body.
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => {
        server.removeListener('listening', onListening);
        this.server = null;
        reject(e);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        this.actualPort = (server.address() as AddressInfo).port;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.opts.port, this.opts.host);
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    if (!s) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      s.close(() => resolve());
      // Drop keep-alive sockets so close() does not hang on an idle peer.
      (s as http.Server).closeAllConnections?.();
    });
  }

  // ---- request handling ------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = normaliseRemoteAddress(req.socket.remoteAddress);
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const reject = (e: A2AProtocolError, peer?: string): never => {
      this.opts.handlers.onRejected?.({ route: `${method} ${path}`, status: e.httpStatus, reason: e.reason, peer, remote });
      throw e;
    };

    // 1. network allow-list, for every route.
    if (!ipInCidrs(remote, this.opts.allowCidrs())) reject(errors.notAllowed());

    // 2. public card.
    if (method === 'GET' && path === '/.well-known/agent-card.json') {
      return this.sendJson(res, 200, this.opts.handlers.card(), 'application/json');
    }

    // 3. pairing: unauthenticated by design, rate limited per address.
    if (path === '/a2a-pair') {
      if (method !== 'POST') reject(errors.notFound());
      this.checkVersion(req, reject);
      if (!this.pairLimiter.allow(remote)) reject(errors.rateLimited());
      const body = (await this.readJson(req, reject)) as PairRequest;
      const out = await this.opts.handlers.pair(body, remote);
      return this.sendJson(res, 200, out);
    }

    // 4. everything else needs a paired peer.
    const auth = String(req.headers.authorization ?? '');
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    const peer = m ? this.opts.handlers.authenticate(m[1]) : undefined;
    if (!peer) reject(errors.unauthenticated());
    const p = peer!;
    if (this.opts.handlers.effectiveTrust(p) === 'blocked') reject(errors.blocked(), p.peer_id);
    this.checkVersion(req, (e) => reject(e, p.peer_id));
    if (!this.peerLimiter.allow(p.peer_id)) reject(errors.rateLimited(), p.peer_id);
    this.opts.handlers.onPeerSeen?.(p);

    if (method === 'POST' && path === '/message:send') {
      const body = (await this.readJson(req, (e) => reject(e, p.peer_id))) as SendMessageRequest;
      const task = await this.opts.handlers.sendMessage(p, body);
      // proto SendMessageResponse is a oneof {task, message}; we always create a task.
      return this.sendJson(res, 200, { task });
    }
    if (method === 'GET' && path === '/extendedAgentCard') {
      return this.sendJson(res, 200, this.opts.handlers.extendedCard(p));
    }
    const taskRoute = /^\/tasks\/([^/:]+)(:cancel)?$/.exec(path);
    if (taskRoute) {
      const id = decodeURIComponent(taskRoute[1]);
      if (method === 'GET' && !taskRoute[2]) return this.sendJson(res, 200, this.opts.handlers.getTask(p, id));
      if (method === 'POST' && taskRoute[2]) {
        await this.drain(req, (e) => reject(e, p.peer_id));
        return this.sendJson(res, 200, this.opts.handlers.cancelTask(p, id));
      }
    }
    if (path === '/a2a-push') {
      if (method !== 'POST') reject(errors.notFound(), p.peer_id);
      const body = (await this.readJson(req, (e) => reject(e, p.peer_id))) as StreamResponse;
      const tok = String(req.headers['x-a2a-notification-token'] ?? '');
      const r = this.opts.handlers.push(p, body, tok);
      return this.sendJson(res, 200, r);
    }
    if (path === '/a2a-unpair') {
      if (method !== 'POST') reject(errors.notFound(), p.peer_id);
      await this.drain(req, (e) => reject(e, p.peer_id));
      this.opts.handlers.unpaired(p);
      return this.sendJson(res, 200, {});
    }
    if (method === 'GET' && path === '/tasks') {
      return this.sendJson(res, 200, this.opts.handlers.listTasks(p, url.searchParams));
    }
    reject(errors.notFound(`No route for ${method} ${path}.`), p.peer_id);
  }

  /**
   * The spec says a missing A2A-Version header means 0.3. We only speak 1.0,
   * so both a missing and a different version get a clear error instead of a
   * confusing parse failure later.
   */
  private checkVersion(req: http.IncomingMessage, reject: (e: A2AProtocolError) => never): void {
    const v = String(req.headers['a2a-version'] ?? '').trim();
    if (v !== A2A_PROTOCOL_VERSION) reject(errors.version(v));
  }

  private readBody(req: http.IncomingMessage, reject: (e: A2AProtocolError) => never): Promise<Buffer> {
    const max = LIMITS.maxBodyBytes;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      reject(errors.tooLarge(max));
    }
    return new Promise((resolve, rejectP) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > max) {
          done = true;
          // Stop buffering but keep draining so we can still write the 413.
          req.resume();
          try {
            reject(errors.tooLarge(max));
          } catch (e) {
            rejectP(e);
          }
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!done) resolve(Buffer.concat(chunks));
      });
      req.on('error', (e) => {
        if (!done) rejectP(e);
      });
    });
  }

  private async drain(req: http.IncomingMessage, reject: (e: A2AProtocolError) => never): Promise<void> {
    await this.readBody(req, reject);
  }

  private async readJson(req: http.IncomingMessage, reject: (e: A2AProtocolError) => never): Promise<unknown> {
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ct !== A2A_CONTENT_TYPE && ct !== 'application/json') {
      req.resume();
      reject(errors.contentType());
    }
    const buf = await this.readBody(req, reject);
    try {
      const v = JSON.parse(buf.toString('utf8'));
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      return v;
    } catch {
      return reject(errors.badRequest('Body is not a JSON object.'));
    }
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown, contentType = A2A_CONTENT_TYPE): void {
    const s = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': Buffer.byteLength(s),
      'A2A-Version': A2A_PROTOCOL_VERSION,
      'Cache-Control': 'no-store',
    });
    res.end(s);
  }

  private sendError(res: http.ServerResponse, e: unknown): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const err = e instanceof A2AProtocolError ? e : new A2AProtocolError(500, 'INTERNAL', 'Internal error.');
    // Close after an error response: the request body may not have been read,
    // and reusing the socket would desync the next request.
    res.setHeader('Connection', 'close');
    this.sendJson(res, err.httpStatus, err.toBody());
  }
}
