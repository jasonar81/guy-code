// @vitest-environment node
/**
 * A2A relay, step 3: the client transport (docs/a2a/DESIGN.md 11a).
 *
 * THE POINT OF THE FEATURE: on a Fortinet-style VPN two laptops can never
 * connect to each other. The first test is that situation exactly - two
 * agents, NEITHER listening on any port, pair and then exchange a message and
 * a task, with every byte going out over connections they opened to the relay.
 *
 * Everything is real: RelayServer from relay/, A2ANode + RelayClient from
 * electron/a2a, sql.js databases, generated P-256 certificates. Nothing is
 * mocked between the two agents and the relay.
 */
import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayServer } from '../../../relay/src/server';
import { RelayLogger } from '../../../relay/src/log';
import { decodePairingCode } from '../../../electron/a2a/pairing';
import { sendMessage, PeerOfflineError } from '../../../electron/a2a/client';
import { cert, makeNode, type TestNode } from '../helpers';
import { connected, makeRelayNode, pairNodes, relayOpts, startRelay, until, type Relay, type RelayNode } from './relayHelpers';

const live: TestNode[] = [];
const relays: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (live.length) await live.pop()!.node.stop().catch(() => {});
  while (relays.length) await relays.pop()!.stop().catch(() => {});
});

async function relay(limits: Parameters<typeof startRelay>[0] = {}, opts: { fakeClock?: boolean } = {}): Promise<Relay> {
  const r = await startRelay(limits, opts);
  relays.push({ stop: () => r.close() });
  return r;
}

async function relayNode(o: Parameters<typeof makeRelayNode>[0]): Promise<RelayNode> {
  const n = await makeRelayNode(o);
  live.push(n);
  return n;
}

/** Everything the relay received in a request body or wrote down a stream. */
function tapRelay(r: Relay): string[] {
  const seen: string[] = [];
  const s = r.relay as any;
  const readJson = s.readJson.bind(s);
  s.readJson = async (req: unknown) => {
    const v = await readJson(req);
    seen.push(JSON.stringify(v));
    return v;
  };
  const writeRaw = s.writeRaw.bind(s);
  s.writeRaw = (st: unknown, chunk: string) => {
    seen.push(chunk);
    return writeRaw(st, chunk);
  };
  return seen;
}

const peerRow = (t: TestNode, id: string) => t.node.store.getPeer(id)!;
const inTasks = (t: TestNode) => t.node.store.listTasks({ direction: 'in' });

describe('two agents with NO listening port pair and work together through the relay', () => {
  it('pairs, sends a message, and runs a task to COMPLETED - neither side ever calls listen()', async () => {
    const r = await relay();
    const wire = tapRelay(r);
    // From here on, any attempt by anyone to listen is recorded. The relay is
    // already listening; the agents must never call listen() at all.
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');

    const jason = await relayNode({ name: 'Jason', certIndex: 0, relayPort: r.port });
    const dylan = await relayNode({ name: 'Dylan', certIndex: 1, relayPort: r.port });
    expect(jason.node.isListening()).toBe(false);
    expect(jason.node.cardUrl()).toBe(`relay://${jason.node.fingerprint()}/.well-known/agent-card.json`);

    // 1. Pairing through the relay: the code names the relay and the inviter's key, no address.
    const { code } = jason.node.invite();
    const payload = decodePairingCode(code);
    expect(payload.relayUrl).toBe(`http://127.0.0.1:${r.port}`);
    expect(payload.relayKey).toBeTruthy();
    const jasonAsSeenByDylan = await dylan.node.redeem(code);
    const dylanAsSeenByJason = jason.node.store.listPeers().find((p) => p.cert_sha256 === dylan.node.fingerprint())!;
    expect(dylanAsSeenByJason).toBeTruthy();
    expect(jasonAsSeenByDylan.card_url.startsWith('relay://')).toBe(true);
    expect(jasonAsSeenByDylan.cert_pem).toBe(jason.node.identity().certPem); // relay key available both ways
    expect(dylanAsSeenByJason.cert_pem).toBe(dylan.node.identity().certPem);
    // Single use still holds over the relay.
    await expect(dylan.node.redeem(code)).rejects.toThrow(/already been used/);

    // 2. An inform message, Dylan -> Jason.
    const sent = await dylan.node.send({ peer: jasonAsSeenByDylan.peer_id, text: 'parquet retry policy is changing on Monday' });
    expect(sent.queued).toBeFalsy();
    expect(jason.port.delivered().join('\n')).toMatch(/parquet retry policy is changing on Monday/);

    // 3. A task, Jason -> Dylan, with the answer pushed back through the relay.
    dylan.node.setTrust(jasonAsSeenByDylan.peer_id, 'collaborate');
    const req = await jason.node.request({ peer: dylanAsSeenByJason.peer_id, kind: 'request', text: 'which branch has the H3 fix?' });
    expect(req.queued).toBeFalsy();
    expect(req.state).toBe('TASK_STATE_WORKING');
    dylan.node.reply({ taskId: req.taskId, action: 'complete', text: 'answer: release-7.2' });
    await dylan.node.flushOutbox();
    await jason.node.flushOutbox();
    const done = jason.node.store.getTask(req.taskId)!;
    expect(done.state).toBe('TASK_STATE_COMPLETED');
    expect(done.artifacts_json ?? done.last_status_json).toMatch(/release-7\.2/);

    expect(listenSpy).not.toHaveBeenCalled();

    // 4. ...and the relay saw none of it in the clear.
    const all = [wire.join('\n'), r.logs.join('\n'), r.relay.dumpState()].join('\n');
    const secrets = [
      'parquet retry policy',
      'which branch has the H3 fix',
      'release-7.2',
      payload.inviteSecret,
      dylan.node.store.getOutboundToken(jasonAsSeenByDylan)!,
      jason.node.store.getOutboundToken(dylanAsSeenByJason)!,
      'Bearer ' + dylan.node.store.getOutboundToken(jasonAsSeenByDylan)!,
    ];
    expect(wire.length).toBeGreaterThan(5);
    for (const s of secrets) expect(all).not.toContain(s);
  });

  it('a relay-only agent with no relay configured refuses to make a pairing code nobody could redeem', async () => {
    const t = await makeNode({ name: 'Solo', certIndex: 4, extra: { listen: false } });
    live.push(t);
    expect(() => t.node.invite()).toThrow(/relay/);
  });
});

describe('direct first, relay on failure', () => {
  async function listeningPair(r: Relay) {
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: r.port, listen: true });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: r.port, listen: true });
    const ids = await pairNodes(a, b);
    return { a, b, ...ids };
  }

  it('when the peer IS reachable directly, the relay is not used', async () => {
    const r = await relay();
    const { a, b, bSeesA } = await listeningPair(r);
    const spyA = vi.spyOn(a.node.relayClient()!, 'request');
    const spyB = vi.spyOn(b.node.relayClient()!, 'request');
    const res = await b.node.send({ peer: bSeesA, text: 'hello directly' });
    expect(res.queued).toBeFalsy();
    expect(a.port.delivered().join('\n')).toMatch(/hello directly/);
    expect(spyA).not.toHaveBeenCalled();
    expect(spyB).not.toHaveBeenCalled();
  });

  it('when the peer is unreachable, the relay carries it and the reply comes back to the caller', async () => {
    const r = await relay();
    const { a, b, aSeesB, bSeesA } = await listeningPair(r);
    a.node.setTrust(aSeesB, 'collaborate');
    // Alice's address goes dead from Bob's point of view (port 1 refuses).
    b.sql.prepare('UPDATE a2a_peers SET card_url = ? WHERE peer_id = ?').run('https://127.0.0.1:1/.well-known/agent-card.json', bSeesA);
    const spy = vi.spyOn(b.node.relayClient()!, 'request');
    const res = await b.node.request({ peer: bSeesA, kind: 'request', text: 'via the relay please' });
    expect(res.queued).toBeFalsy();
    expect(res.state).toBe('TASK_STATE_WORKING'); // the peer's real answer, not a placeholder
    expect(spy).toHaveBeenCalledTimes(1);
    expect(inTasks(a)).toHaveLength(1);
    expect(a.port.delivered().join('\n')).toMatch(/via the relay please/);
  });

  it('a certificate pin mismatch is NEVER relayed: it stays a hard error', async () => {
    const r = await relay();
    const { b, bSeesA } = await listeningPair(r);
    // An impostor answers at Alice's address with a different certificate.
    const impostor = await makeNode({ name: 'Mallory', certIndex: 2 });
    live.push(impostor);
    b.sql.prepare('UPDATE a2a_peers SET card_url = ? WHERE peer_id = ?').run(impostor.node.cardUrl(), bSeesA);
    const spy = vi.spyOn(b.node.relayClient()!, 'request');
    const err = await b.node.send({ peer: bSeesA, text: 'secret' }).catch((e) => e);
    expect(err?.name).toBe('CertPinMismatchError');
    expect(spy).not.toHaveBeenCalled();
    expect(b.node.store.listOutbox()).toHaveLength(0);
    expect(inTasks(impostor)).toHaveLength(0);
  });

  it('a peer paired before relay support (no stored cert) gets the re-pair message, not a crash', async () => {
    const r = await relay();
    const { b, bSeesA } = await listeningPair(r);
    b.sql.prepare('UPDATE a2a_peers SET cert_pem = NULL, card_url = ? WHERE peer_id = ?').run('https://127.0.0.1:1/.well-known/agent-card.json', bSeesA);
    const spy = vi.spyOn(b.node.relayClient()!, 'request');
    const ep = (b.node as any).endpointFor(peerRow(b, bSeesA));
    const err = await sendMessage(ep, { message: { messageId: 'x', role: 'ROLE_USER', parts: [{ text: 'hi' }] } } as any).catch((e) => e);
    expect(err).toBeInstanceOf(PeerOfflineError);
    expect(err.message).toMatch(/paired before relay support; re-pair Alice to use the relay/);
    // Through the normal tool path it is queued, with the same explanation in the audit.
    const res = await b.node.send({ peer: bSeesA, text: 'hi' });
    expect(res.queued).toBe(true);
    expect(JSON.stringify(b.node.audit.tail(20))).toMatch(/re-pair Alice to use the relay/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('delivery semantics', () => {
  it('a redelivered msgId is ignored: the stream dies mid-flight, the relay redelivers, it runs once', async () => {
    const r = await relay();
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: r.port });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: r.port });
    const { bSeesA } = await pairNodes(a, b);

    const c = a.node.relayClient() as any;
    let envelopes = 0;
    const onEnvelope = c.onEnvelope.bind(c);
    c.onEnvelope = (env: any) => {
      envelopes++;
      return onEnvelope(env);
    };
    let handled = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const handle = c.opts.handle;
    c.opts.handle = async (req: unknown) => {
      handled++;
      await gate;
      return handle(req);
    };

    const sending = b.node.send({ peer: bSeesA, text: 'exactly once please' });
    await until(() => handled === 1);
    c.dropConnection(); // Alice's laptop sleeps before it can answer
    const res = await sending;
    expect(res.queued).toBe(true); // the relay told Bob it will redeliver

    await connected(a);
    await until(() => envelopes === 2); // ...and it did
    expect(handled).toBe(1); // the repeat was ignored while the first is still running
    release();
    await until(() => inTasks(a).length === 1);

    // Bob's own outbox retry (same A2A messageId) is deduplicated too.
    b.clock.now += 10 * 60_000;
    await b.node.flushOutbox();
    expect(b.node.store.listOutbox()).toHaveLength(0);
    expect(handled).toBe(2); // that one is a new msgId and is handled, but...
    expect(inTasks(a)).toHaveLength(1); // ...no second task,
    expect(a.port.delivered().filter((t) => t.includes('exactly once please'))).toHaveLength(1); // no second delivery
  });

  it('a repeat of an answered msgId re-sends the cached reply and has no side effects', async () => {
    const r = await relay();
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: r.port });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: r.port });
    const { bSeesA } = await pairNodes(a, b);
    const c = a.node.relayClient() as any;
    const captured: any[] = [];
    const onEnvelope = c.onEnvelope.bind(c);
    c.onEnvelope = (env: any) => {
      captured.push(env);
      return onEnvelope(env);
    };
    let handled = 0;
    const handle = c.opts.handle;
    c.opts.handle = (req: unknown) => {
      handled++;
      return handle(req);
    };
    await b.node.send({ peer: bSeesA, text: 'once' });
    expect(handled).toBe(1);
    await onEnvelope(captured[0]);
    await onEnvelope(captured[0]);
    expect(handled).toBe(1);
    expect(inTasks(a)).toHaveLength(1);
    expect(a.port.delivered()).toHaveLength(1);
  });
});

describe('relay TLS and identity binding', () => {
  async function tlsRelay() {
    const id = cert(7);
    const s = new RelayServer({ host: '127.0.0.1', port: 0, tls: { certPem: id.certPem, keyPem: id.keyPem }, limits: { connectsPerMinutePerIp: 10_000 }, logger: new RelayLogger(() => {}) });
    await s.start();
    relays.push(s);
    return { s, fp: id.fingerprint };
  }

  it('with no pin configured, pins the relay certificate on first use and reports it', async () => {
    const { s, fp } = await tlsRelay();
    const learned: string[] = [];
    const a = await makeNode({ name: 'Alice', certIndex: 0, extra: { listen: false, relay: relayOpts(0, { url: `https://127.0.0.1:${s.port()}`, onPinLearned: (f) => void learned.push(f) }) } });
    live.push(a);
    await connected(a);
    expect(learned[0]).toBe(fp);
    expect(a.node.relayStatus()!.relayCertSha256).toBe(fp);
  });

  it('a relay presenting a different certificate than the pin is refused', async () => {
    const { s } = await tlsRelay();
    const a = await makeNode({ name: 'Alice', certIndex: 0, extra: { listen: false, relay: relayOpts(0, { url: `https://127.0.0.1:${s.port()}`, certSha256: 'ab'.repeat(32) }) } });
    live.push(a);
    await until(() => /certificate/.test(a.node.relayStatus()!.lastError ?? ''));
    expect(a.node.relayClient()!.isConnected()).toBe(false);
    expect(s.stats().agents).toBe(0);
  });

  it('through the relay, a bearer token only works for the identity the relay proved', async () => {
    const r = await relay();
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: r.port });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: r.port });
    const { bSeesA } = await pairNodes(a, b);
    const token = b.node.store.getOutboundToken(peerRow(b, bSeesA))!;
    // Bob's token, but presented as if from some other paired-looking fingerprint.
    const out = await (a.node as any).server.handleRelayed({
      method: 'POST',
      path: '/message:send',
      headers: { authorization: `Bearer ${token}`, 'a2a-version': '1.0', 'content-type': 'application/a2a+json' },
      body: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } },
      from: 'cd'.repeat(32),
    });
    expect(out.status).toBe(401);
    expect(inTasks(a)).toHaveLength(0);
  });
});

describe('the relay going away', () => {
  it('reconnects after the relay restarts, and the outbox delivers what queued meanwhile', async () => {
    const r = await relay();
    const port = r.port;
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: port });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: port });
    const { bSeesA } = await pairNodes(a, b);

    await r.relay.stop();
    await until(() => b.node.relayStatus()!.state !== 'connected' && a.node.relayStatus()!.state !== 'connected');
    await until(() => !!b.node.relayStatus()!.lastError);

    const res = await b.node.send({ peer: bSeesA, text: 'sent while the relay was down' });
    expect(res.queued).toBe(true);
    expect(JSON.stringify(b.node.audit.tail(10))).toMatch(/relay is (connecting|disconnected)/);

    const again = new RelayServer({ host: '127.0.0.1', port, limits: { connectsPerMinutePerIp: 10_000 }, logger: new RelayLogger(() => {}) });
    await again.start();
    relays.push(again);
    await connected(a);
    await connected(b);
    expect(b.node.relayStatus()!.lastError).toBeNull();

    b.clock.now += 10 * 60_000;
    await b.node.flushOutbox();
    expect(b.node.store.listOutbox()).toHaveLength(0);
    expect(a.port.delivered().join('\n')).toMatch(/sent while the relay was down/);
    expect(b.node.store.getTask(res.taskId)).toBeUndefined(); // placeholder replaced by the real task
  });

  it('a message for a peer that is offline is held by the relay and delivered when they reconnect', async () => {
    const r = await relay();
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: r.port });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: r.port });
    const { bSeesA } = await pairNodes(a, b);

    a.node.setRelay(null); // Alice goes offline
    await until(() => r.relay.stats().agents === 1);
    const res = await b.node.send({ peer: bSeesA, text: 'for when you are back' });
    expect(res.queued).toBe(true);
    expect(inTasks(a)).toHaveLength(0);

    a.node.setRelay(relayOpts(r.port)); // Alice comes back
    await connected(a);
    await until(() => inTasks(a).length === 1); // delivered by the relay, no retry needed
    expect(a.port.delivered().join('\n')).toMatch(/for when you are back/);

    b.clock.now += 10 * 60_000;
    await b.node.flushOutbox(); // Bob's own retry dedups against it
    expect(inTasks(a)).toHaveLength(1);
    expect(b.node.store.listOutbox()).toHaveLength(0);
  });

  it('a "dropped" event reaches the sender: queued too long', async () => {
    const r = await relay({}, { fakeClock: true });
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: r.port });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: r.port });
    const { bSeesA } = await pairNodes(a, b);
    a.node.setRelay(null);
    await until(() => r.relay.stats().agents === 1);
    await b.node.send({ peer: bSeesA, text: 'you will never see this' });
    r.clock.t += 25 * 3_600_000;
    r.relay.sweep();
    await until(() => b.dropped.length === 1);
    expect(b.dropped[0].to).toBe(a.node.fingerprint());
    expect(b.dropped[0].reason).toMatch(/expired/);
    expect(JSON.stringify(b.node.audit.tail(10))).toMatch(/relay\.dropped/);
  });

  it('a "dropped" event fails a caller still waiting for the reply', async () => {
    const r = await relay({ replyTimeoutMs: 100 }, { fakeClock: true });
    const a = await relayNode({ name: 'Alice', certIndex: 0, relayPort: r.port });
    const b = await relayNode({ name: 'Bob', certIndex: 1, relayPort: r.port });
    const { bSeesA } = await pairNodes(a, b);
    const c = a.node.relayClient() as any;
    let handled = 0;
    c.opts.handle = () => {
      handled++;
      return new Promise(() => {}); // Alice's agent hangs and never answers
    };
    const sending = b.node.send({ peer: bSeesA, text: 'hello?' });
    await until(() => handled === 1);
    await new Promise((res) => setTimeout(res, 300)); // past replyTimeoutMs: Bob now waits on his stream
    r.clock.t += 25 * 3_600_000;
    r.relay.sweep();
    const res = await sending;
    expect(res.queued).toBe(true);
    expect(JSON.stringify(b.node.audit.tail(10))).toMatch(/Not delivered: the relay dropped the message/);
  });
});
