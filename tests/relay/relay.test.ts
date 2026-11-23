// @vitest-environment node
/**
 * A2A relay server (docs/a2a/DESIGN.md 11a), tested in-process on an
 * ephemeral port with real sockets. The agents in these tests are built only
 * from outbound http.request calls (tests/relay/helpers.ts) - the same
 * position as two laptops on a Fortinet VPN that can dial out but never be
 * dialled.
 */
import * as net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealEnvelope } from '../../electron/a2a/relayCrypto';
import { signChallenge, verifyProof, authMessage } from '../../relay/src/identity';
import { RelayLogger } from '../../relay/src/log';
import { validateEnvelope } from '../../relay/src/server';
import { cert, request, sleep, startRelay, until, wireLog, type Harness } from './helpers';

const TOKEN = 'super-secret-peer-token-0123456789abcdef';
const TEXT = 'the retry policy changed in S3ChunkStream';
const payload = (n = 0) => ({ method: 'POST', path: '/message:send', headers: { Authorization: `Bearer ${TOKEN}` }, body: { text: `${TEXT} #${n}` } });

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
  vi.restoreAllMocks();
});

describe('relay: routing', () => {
  it('A sends to B, B receives it, and B\'s reply comes back to A on the same request', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    let got: any = null;
    b.onEnvelope = (p) => {
      got = p;
      return { method: '200', path: '', headers: {}, body: { ok: true, echo: (p.body as any).text } };
    };
    const r = await a.send(b, 'm-1', payload(1));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('delivered');
    expect(got.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const reply = a.open(b, r.body.reply);
    expect(reply.body).toEqual({ ok: true, echo: `${TEXT} #1` });
    expect(r.body.reply.msgId).toBe('m-1');
  });

  it('NEITHER AGENT LISTENS ON ANY PORT: every agent socket is an outbound connection to the relay', async () => {
    h = await startRelay();
    // From here on, any attempt by anyone to listen is recorded. The relay is
    // already listening; the agents must never call listen() at all.
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');

    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    b.onEnvelope = () => ({ method: '200', path: '', headers: {}, body: 'pong' });
    const r = await a.send(b, 'no-listen', payload());
    expect(r.status).toBe(200);
    expect(b.open(a, r.body.reply).body).toBe('pong');

    expect(listenSpy).not.toHaveBeenCalled();
    // And each agent's stream socket points AT the relay: remote = relay port,
    // local = some ephemeral port the OS picked for an outbound connection.
    for (const agent of [a, b]) {
      const sock = agent.req!.socket!;
      expect(sock.remotePort).toBe(h.port);
      expect(sock.localPort).not.toBe(h.port);
    }
  });

  it('a reply after the send timeout arrives on the sender\'s stream as a "reply" event', async () => {
    h = await startRelay({ replyTimeoutMs: 100 });
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    const r = await a.send(b, 'slow', payload());
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('awaiting_reply');
    const env = (await b.waitFor((e) => e.event === 'envelope')).data;
    const rr = await b.post('/relay/v1/reply', { to: a.fp, from: b.fp, msgId: env.msgId, ...sealEnvelope(b.key(a), { method: '200', path: '', headers: {}, body: 'late' }) });
    expect(rr.status).toBe(200);
    const ev = await a.waitFor((e) => e.event === 'reply');
    expect(a.open(b, ev.data).body).toBe('late');
  });

  it('rejects a send whose "from" is not the proven identity, and unauthenticated sends', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    const c = h.agent(2);
    const forged = { ...a.envelopeTo(b, 'f', payload()), from: c.fp };
    expect((await a.post('/relay/v1/send', forged)).status).toBe(403);
    const noAuth = await request(h.port, 'POST', '/relay/v1/send', a.envelopeTo(b, 'g', payload()));
    expect(noAuth.status).toBe(401);
  });

  it('health needs no auth and exposes only counts', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const r = await request(h.port, 'GET', '/relay/v1/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, agents: 1, streams: 1 });
    expect(JSON.stringify(r.body)).not.toContain(a.fp.slice(0, 12));
  });
});

describe('relay: identity proof', () => {
  it('rejects a wrong signature and closes the stream (one guess per nonce)', async () => {
    h = await startRelay();
    const a = h.agent(0);
    await a.openStream();
    const bad = signChallenge('some-other-nonce', a.id.keyPem);
    const r = await a.auth({ signature: bad });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('auth_failed');
    await until(() => a.res!.destroyed || a.res!.complete);
    expect(h.relay.stats().agents).toBe(0);
    // Retrying with a now-correct signature on the same stream is refused: the nonce is spent.
    expect((await a.auth()).status).toBe(404);
  });

  it('an agent cannot register as a fingerprint it has no key for', async () => {
    h = await startRelay();
    const victim = cert(1);
    const mallory = h.agent(2);

    // (1) Present the victim's (public) cert and fingerprint, sign with own key.
    await mallory.openStream();
    const r1 = await mallory.auth({ fingerprint: victim.fingerprint, certPem: victim.certPem, keyPem: mallory.id.keyPem });
    expect(r1.status).toBe(401);
    expect(r1.body.error.message).toMatch(/signature does not verify/);

    // (2) Claim the victim's fingerprint with own cert + valid own signature.
    await mallory.openStream();
    const r2 = await mallory.auth({ fingerprint: victim.fingerprint });
    expect(r2.status).toBe(401);
    expect(r2.body.error.message).toMatch(/does not match the claimed fingerprint/);

    expect(h.relay.stats().agents).toBe(0);
  });

  it('verifyProof: unit checks', () => {
    const a = cert(0);
    const sig = signChallenge('n1', a.keyPem);
    expect(verifyProof({ nonce: 'n1', claimedFingerprint: a.fingerprint, certPem: a.certPem, signature: sig })).toEqual({ ok: true, fingerprint: a.fingerprint });
    expect(verifyProof({ nonce: 'n2', claimedFingerprint: a.fingerprint, certPem: a.certPem, signature: sig }).ok).toBe(false);
    expect(verifyProof({ nonce: 'n1', claimedFingerprint: a.fingerprint, certPem: a.certPem, signature: 'AAAA' }).ok).toBe(false);
    expect(verifyProof({ nonce: 'n1', claimedFingerprint: 'abc', certPem: a.certPem, signature: sig }).ok).toBe(false);
    expect(verifyProof({ nonce: 'n1', claimedFingerprint: a.fingerprint, certPem: 'junk', signature: sig }).ok).toBe(false);
    expect(authMessage('x').toString()).toBe('a2a-relay-auth-v1\nx');
  });

  it('an unauthenticated stream is closed after the auth timeout', async () => {
    h = await startRelay({ authTimeoutMs: 100 });
    const a = h.agent(0);
    await a.openStream();
    await until(() => h!.relay.stats().streams === 0);
  });

  it('a second stream for the same identity replaces the first', async () => {
    h = await startRelay();
    const a1 = await h.agent(0).connect();
    const a2 = await h.agent(0).connect();
    await a1.waitFor((e) => e.event === 'replaced');
    await until(() => h!.relay.stats().streams === 1);
    expect(h.relay.stats().agents).toBe(1);
    expect(a2.session).not.toBe(a1.session);
    expect((await a1.post('/relay/v1/send', a1.envelopeTo(h.agent(1), 'x', payload()))).status).toBe(401);
  });
});

describe('relay: store-and-forward', () => {
  it('B offline -> queued -> delivered on reconnect, and B\'s reply reaches A', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    const r = await a.send(b, 'q-1', payload(1));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('queued');
    expect(h.relay.stats().queued).toBe(1);

    b.onEnvelope = (p) => ({ method: '200', path: '', headers: {}, body: { got: (p.body as any).text } });
    await b.connect();
    const ev = await a.waitFor((e) => e.event === 'reply');
    expect(a.open(b, ev.data).body).toEqual({ got: `${TEXT} #1` });
    expect(h.relay.stats()).toMatchObject({ queued: 0, inflight: 0 });
  });

  it('queued messages are delivered in order', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    for (let i = 0; i < 5; i++) expect((await a.send(b, `o-${i}`, payload(i))).status).toBe(202);
    await b.connect();
    await until(() => b.events.filter((e) => e.event === 'envelope').length === 5);
    expect(b.events.filter((e) => e.event === 'envelope').map((e) => e.data.msgId)).toEqual(['o-0', 'o-1', 'o-2', 'o-3', 'o-4']);
  });

  it('TTL expiry drops the message, logs it, and reports it to the sender', async () => {
    h = await startRelay({ queueTtlMs: 60_000 }, { fakeClock: true });
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    expect((await a.send(b, 'ttl-1', payload())).status).toBe(202);
    h.clock.t += 61_000;
    h.relay.sweep();
    const ev = await a.waitFor((e) => e.event === 'dropped');
    expect(ev.data).toMatchObject({ msgId: 'ttl-1', to: b.fp });
    expect(ev.data.reason).toMatch(/expired/);
    expect(h.relay.stats().queued).toBe(0);
    expect(h.logs.some((l) => l.includes('"event":"dropped"') && l.includes('"reason":"expired"'))).toBe(true);
    // B reconnecting later gets nothing.
    await b.connect();
    await sleep(50);
    expect(b.events.some((e) => e.event === 'envelope')).toBe(false);
  });

  it('a drop notice for an offline sender is queued and delivered when it reconnects', async () => {
    h = await startRelay({ queueTtlMs: 60_000 }, { fakeClock: true });
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    expect((await a.send(b, 'ttl-2', payload())).status).toBe(202);
    a.kill();
    await until(() => h!.relay.stats().agents === 0);
    h.clock.t += 61_000;
    h.relay.sweep();
    const a2 = await h.agent(0).connect();
    const ev = await a2.waitFor((e) => e.event === 'dropped');
    expect(ev.data.msgId).toBe('ttl-2');
  });

  it('enforces the per-destination bound with a clear error, logged', async () => {
    h = await startRelay({ maxQueuedPerDestination: 2 });
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    expect((await a.send(b, 'b-1', payload())).status).toBe(202);
    expect((await a.send(b, 'b-2', payload())).status).toBe(202);
    const r = await a.send(b, 'b-3', payload());
    expect(r.status).toBe(507);
    expect(r.body.error.code).toBe('queue_full');
    expect(h.logs.some((l) => l.includes('"reason":"queue_full"'))).toBe(true);
    // Another destination is unaffected.
    expect((await a.send(h.agent(2), 'c-1', payload())).status).toBe(202);
  });

  it('a duplicate msgId from the same sender is refused while the first is pending', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    expect((await a.send(b, 'dup', payload())).status).toBe(202);
    expect((await a.send(b, 'dup', payload())).status).toBe(409);
  });

  it('a stream that dies mid-flight does not wedge the queue: the message is redelivered and later mail flows', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b1 = await h.agent(1).connect();
    // B receives the envelope but dies before replying.
    const sendP = a.send(b1, 'mid-1', payload(1));
    await b1.waitFor((e) => e.event === 'envelope');
    b1.kill();
    const r = await sendP;
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('queued');
    await until(() => h!.relay.stats().agents === 1);
    expect(h.relay.stats()).toMatchObject({ queued: 1, inflight: 0 });

    // Further mail queues behind it rather than being blocked.
    expect((await a.send(b1, 'mid-2', payload(2))).status).toBe(202);

    const b2 = h.agent(1);
    b2.onEnvelope = (p) => ({ method: '200', path: '', headers: {}, body: (p.body as any).text });
    await b2.connect();
    await until(() => a.events.filter((e) => e.event === 'reply').length === 2);
    const replies = a.events.filter((e) => e.event === 'reply');
    expect(replies.map((e) => e.data.msgId)).toEqual(['mid-1', 'mid-2']);
    expect(a.open(b2, replies[0].data).body).toBe(`${TEXT} #1`);
    expect(h.relay.stats()).toMatchObject({ queued: 0, inflight: 0 });
  });
});

describe('relay: never sees plaintext', () => {
  it('the token and message text are absent from everything the relay receives, stores and logs', async () => {
    h = await startRelay({ replyTimeoutMs: 200 });
    wireLog.length = 0;
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    // Queued (stored) ...
    await a.send(b, 'p-1', payload(1));
    const stored = h.relay.dumpState();
    b.onEnvelope = (p) => ({ method: '200', path: '', headers: { Authorization: `Bearer ${TOKEN}` }, body: { echo: (p.body as any).text } });
    await b.connect();
    // ... and live.
    const live = await a.send(b, 'p-2', payload(2));
    expect(live.status).toBe(200);
    await a.waitFor((e) => e.event === 'reply');
    expect(a.open(b, live.body.reply).body).toEqual({ echo: `${TEXT} #2` });

    const everything = [...wireLog, stored, h.relay.dumpState(), ...h.logs, JSON.stringify(b.events), JSON.stringify(a.events)].join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(TEXT);
    // Not even base64-encoded (i.e. the relay was not handed a mere encoding).
    expect(everything).not.toContain(Buffer.from(TEXT).toString('base64').slice(0, 20));
  });

  it('logs never contain ct, iv, tag, nonce, session or a full fingerprint', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    b.onEnvelope = () => ({ method: '200', path: '', headers: {}, body: 'ok' });
    const env = a.envelopeTo(b, 'log-1', payload());
    const r = await a.post('/relay/v1/send', env);
    expect(r.status).toBe(200);
    const logs = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const secret of [env.ct, env.iv, env.tag, r.body.reply.ct, a.session, b.session, a.nonce, a.fp, b.fp]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).toContain(a.fp.slice(0, 12)); // prefixes only
  });

  it('the logger refuses secret field names and truncates long hex/base64 values', () => {
    const lines: string[] = [];
    const log = new RelayLogger((l) => lines.push(l));
    const fp = cert(0).fingerprint;
    log.info('x', { ct: 'AAAA', iv: 'BBBB', tag: 'CCCC', note: `fp=${fp}`, blob: 'Q'.repeat(60) });
    const out = JSON.parse(lines[0]);
    expect(out.ct).toBeUndefined();
    expect(out.ct_refused).toBe(true);
    expect(out.iv).toBeUndefined();
    expect(lines[0]).not.toContain(fp);
    expect(out.note).toContain(fp.slice(0, 12));
    expect(out.blob).toBe('[redacted]');
  });

  it('only {to, from, msgId, iv, ct, tag} are accepted: a plaintext field riding alongside is refused', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    const r = await a.post('/relay/v1/send', { ...a.envelopeTo(b, 'x-1', payload()), body: TEXT });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/Unexpected field/);
    expect(h.relay.dumpState()).not.toContain(TEXT);
    expect(h.logs.join('\n')).not.toContain(TEXT);
    expect(() => validateEnvelope({ to: b.fp, from: a.fp, msgId: 'm', iv: 'x', ct: 'y', tag: 'z' })).toThrow(/iv/);
  });
});

describe('relay: limits', () => {
  it('rejects an oversized envelope with 413', async () => {
    h = await startRelay({ maxEnvelopeBytes: 4096 });
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    const r = await a.send(b, 'big', { method: 'POST', path: '/', headers: {}, body: 'x'.repeat(10_000) });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('too_large');
    expect(r.body.error.message).toMatch(/4096/);
  });

  it('rate limits sends per agent with 429', async () => {
    h = await startRelay({ sendsPerMinutePerAgent: 3 });
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await a.send(b, `r-${i}`, payload())).status);
    expect(statuses).toEqual([202, 202, 202, 429, 429]);
    // Per agent: someone else is unaffected.
    const c = await h.agent(2).connect();
    expect((await c.send(b, 'c-0', payload())).status).toBe(202);
  });

  it('refuses streams past the concurrent limit with 503', async () => {
    h = await startRelay({ maxStreams: 2 });
    await h.agent(0).connect();
    await h.agent(1).connect();
    const c = h.agent(2);
    await expect(c.openStream()).rejects.toMatchObject({ status: 503 });
    expect(h.logs.some((l) => l.includes('"reason":"max_streams"'))).toBe(true);
  });

  it('unknown routes are 404 and bad JSON is 400', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    expect((await request(h.port, 'GET', '/nope')).status).toBe(404);
    expect((await request(h.port, 'POST', '/relay/v1/send', '{not json', { Authorization: `Bearer ${a.session}` })).status).toBe(400);
  });
});
