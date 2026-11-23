/**
 * Test agent for the relay. Built ONLY on outbound http.request: it opens the
 * SSE stream and POSTs envelopes, exactly like a laptop behind the VPN. It
 * never creates a server or listens on a port - relay.test.ts asserts that.
 *
 * Tests may import from electron/ (the real crypto and cert generator); the
 * relay itself must not, and does not.
 */
import * as http from 'node:http';
import { generateSelfSignedCert, type TlsIdentity } from '../../electron/a2a/tls';
import { deriveRelayKey, openEnvelope, sealEnvelope, type RelayPayload } from '../../electron/a2a/relayCrypto';
import { signChallenge } from '../../relay/src/identity';
import { RelayLogger } from '../../relay/src/log';
import { RelayServer, type RelayLimits } from '../../relay/src/server';

const _certs: TlsIdentity[] = [];
export function cert(i: number): TlsIdentity {
  while (_certs.length <= i) _certs.push(generateSelfSignedCert({ commonName: `relay-test-${_certs.length}` }));
  return _certs[i];
}

export interface SseEvent {
  event: string;
  data: any;
}

export interface HttpResult {
  status: number;
  body: any;
}

/** Every byte any client sent to the relay, for the "no plaintext" assertions. */
export const wireLog: string[] = [];

export function request(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResult> {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  if (data) wireLog.push(data);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, agent: false, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const s = Buffer.concat(chunks).toString('utf8');
          let parsed: any = s;
          try {
            parsed = JSON.parse(s);
          } catch {
            /* keep text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** An agent: dials out to the relay, proves its identity, receives over SSE. */
export class TestAgent {
  readonly events: SseEvent[] = [];
  session = '';
  streamId = '';
  nonce = '';
  req: http.ClientRequest | null = null;
  res: http.IncomingMessage | null = null;
  private waiters: Array<{ pred: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }> = [];
  private buf = '';
  /** Called for each `envelope` event; returning a payload auto-replies (sealed). */
  onEnvelope?: (payload: RelayPayload, env: any) => RelayPayload | undefined;
  closedStatus: number | null = null;

  constructor(
    readonly port: number,
    readonly id: TlsIdentity
  ) {}

  get fp(): string {
    return this.id.fingerprint;
  }

  /** Open the stream and wait for the challenge (does NOT authenticate). */
  openStream(): Promise<SseEvent> {
    // A fresh stream gets a fresh challenge: forget the previous stream's events.
    this.events.length = 0;
    this.buf = '';
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.port, method: 'GET', path: '/relay/v1/stream', agent: false });
      this.req = req;
      req.on('response', (res) => {
        this.res = res;
        if (res.statusCode !== 200) {
          this.closedStatus = res.statusCode ?? 0;
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => reject(Object.assign(new Error(`stream refused ${res.statusCode}`), { status: res.statusCode, body: Buffer.concat(chunks).toString() })));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (c: string) => this.onData(c));
        res.on('error', () => {});
        this.waitFor((e) => e.event === 'challenge').then((e) => {
          this.streamId = e.data.streamId;
          this.nonce = e.data.nonce;
          resolve(e);
        });
      });
      req.on('error', (e) => {
        if (!this.res) reject(e);
      });
      req.end();
    });
  }

  auth(override: Partial<{ fingerprint: string; certPem: string; signature: string; keyPem: string }> = {}): Promise<HttpResult> {
    const signature = override.signature ?? signChallenge(this.nonce, override.keyPem ?? this.id.keyPem);
    return request(this.port, 'POST', '/relay/v1/auth', {
      streamId: this.streamId,
      fingerprint: override.fingerprint ?? this.fp,
      certPem: override.certPem ?? this.id.certPem,
      signature,
    }).then((r) => {
      if (r.status === 200) this.session = r.body.session;
      return r;
    });
  }

  async connect(): Promise<this> {
    await this.openStream();
    const r = await this.auth();
    if (r.status !== 200) throw new Error(`auth failed: ${JSON.stringify(r.body)}`);
    await this.waitFor((e) => e.event === 'ready');
    return this;
  }

  /** Kill the TCP connection abruptly, as a sleeping laptop or dropped VPN would. */
  kill(): void {
    this.req?.destroy();
    this.res?.destroy();
  }

  key(peer: TestAgent): Buffer {
    return deriveRelayKey(this.id.keyPem, peer.id.certPem, this.fp, peer.fp);
  }

  envelopeTo(peer: TestAgent, msgId: string, payload: RelayPayload) {
    return { to: peer.fp, from: this.fp, msgId, ...sealEnvelope(this.key(peer), payload) };
  }

  send(peer: TestAgent, msgId: string, payload: RelayPayload): Promise<HttpResult> {
    return this.post('/relay/v1/send', this.envelopeTo(peer, msgId, payload));
  }

  post(path: string, body: unknown): Promise<HttpResult> {
    return request(this.port, 'POST', path, body, { Authorization: `Bearer ${this.session}` });
  }

  /** Open a reply envelope addressed to us from `peer`. */
  open(peer: TestAgent, env: any): RelayPayload {
    return openEnvelope(this.key(peer), env);
  }

  waitFor(pred: (e: SseEvent) => boolean, timeoutMs = 5_000): Promise<SseEvent> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for SSE event')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          resolve(e);
        },
      });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (!data.length) continue;
      const e: SseEvent = { event, data: JSON.parse(data.join('\n')) };
      this.events.push(e);
      for (const w of [...this.waiters]) {
        if (w.pred(e)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(e);
        }
      }
      if (e.event === 'envelope' && this.onEnvelope) {
        const peer = peers.get(e.data.from);
        if (peer) {
          const reply = this.onEnvelope(this.open(peer, e.data), e.data);
          if (reply) void this.post('/relay/v1/reply', { to: peer.fp, from: this.fp, msgId: e.data.msgId, ...sealEnvelope(this.key(peer), reply) });
        }
      }
    }
  }
}

/** fingerprint -> agent, so auto-reply can find the peer's cert. */
export const peers = new Map<string, TestAgent>();

export interface Harness {
  relay: RelayServer;
  port: number;
  logs: string[];
  agent(i: number): TestAgent;
  clock: { t: number };
  close(): Promise<void>;
}

export async function startRelay(limits: Partial<RelayLimits> = {}, opts: { fakeClock?: boolean } = {}): Promise<Harness> {
  const logs: string[] = [];
  const clock = { t: Date.now() };
  const now = opts.fakeClock ? () => clock.t : Date.now;
  const relay = new RelayServer({ host: '127.0.0.1', port: 0, limits, logger: new RelayLogger((l) => logs.push(l), now), now });
  await relay.start();
  const agents: TestAgent[] = [];
  return {
    relay,
    port: relay.port(),
    logs,
    clock,
    agent(i: number) {
      const a = new TestAgent(relay.port(), cert(i));
      peers.set(a.fp, a);
      agents.push(a);
      return a;
    },
    async close() {
      for (const a of agents) a.kill();
      await relay.stop();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}
