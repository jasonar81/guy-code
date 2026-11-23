// @vitest-environment node
/**
 * Relay rooms (docs/a2a/DESIGN.md 11b), relay side only: join/leave, fan-out
 * to every current member except the sender, offline queueing per member,
 * membership events, limits, and the relay still never seeing plaintext.
 *
 * The room key here is a random 32-byte key shared by the test members - the
 * relay never sees it, which is the point. Real clients also sign each post;
 * that is end to end and invisible to the relay, so it is not modelled here.
 */
import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openEnvelope, sealEnvelope } from '../../electron/a2a/relayCrypto';
import { request, sleep, startRelay, until, wireLog, type Harness, type TestAgent } from './helpers';

const TOKEN = 'room-secret-token-fedcba9876543210';
const TEXT = 'the flaky ja-sql1 perf run is a cold cache';
const ROOM = 'r00m-' + crypto.randomBytes(12).toString('hex');
const ROOM2 = 'other-' + crypto.randomBytes(12).toString('hex');
const roomKey = crypto.randomBytes(32);
const payload = (n = 0) => ({ method: 'POST', path: '/room/post', headers: { Authorization: `Bearer ${TOKEN}` }, body: { text: `${TEXT} #${n}` } });

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const join = (a: TestAgent, room = ROOM) => a.post('/relay/v1/rooms/join', { room });
const leave = (a: TestAgent, room = ROOM) => a.post('/relay/v1/rooms/leave', { room });
const roomEnv = (a: TestAgent, msgId: string, n = 0, room = ROOM) => ({ to: `room:${room}`, from: a.fp, msgId, ...sealEnvelope(roomKey, payload(n)) });
const post = (a: TestAgent, msgId: string, n = 0, room = ROOM) => a.post('/relay/v1/send', roomEnv(a, msgId, n, room));
const envelopes = (a: TestAgent) => a.events.filter((e) => e.event === 'envelope');
const ack = (a: TestAgent, env: any) => a.post('/relay/v1/ack', { room: env.to.slice(5), sender: env.from, msgId: env.msgId });

describe('relay rooms: fan-out', () => {
  it('three members: one posts, the other two receive it, the sender does not get it back', async () => {
    h = await startRelay();
    const [a, b, c] = [await h.agent(0).connect(), await h.agent(1).connect(), await h.agent(2).connect()];
    for (const x of [a, b, c]) expect((await join(x)).status).toBe(200);
    const r = await post(a, 'p-1', 1);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'posted', msgId: 'p-1', delivered: 2, queued: 0, dropped: [] });
    for (const x of [b, c]) {
      const ev = await x.waitFor((e) => e.event === 'envelope');
      expect(ev.data).toMatchObject({ to: `room:${ROOM}`, from: a.fp, msgId: 'p-1' });
      expect((openEnvelope(roomKey, ev.data) as any).body.text).toBe(`${TEXT} #1`);
    }
    await sleep(50);
    expect(envelopes(a)).toHaveLength(0);
    // Acks release the in-flight copies.
    expect(h.relay.stats().roomInflight).toBe(2);
    for (const x of [b, c]) expect((await ack(x, envelopes(x)[0].data)).status).toBe(200);
    expect(h.relay.stats()).toMatchObject({ roomInflight: 0, queued: 0 });
    expect((await ack(b, envelopes(b)[0].data)).status).toBe(404); // already acked
  });

  it('a non-member cannot post to the room', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    await join(b);
    const r = await post(a, 'x-1');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('not_a_member');
    await sleep(30);
    expect(envelopes(b)).toHaveLength(0);
  });

  it('room posts cannot go through /reply, and a duplicate msgId is refused while undelivered', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    await join(a);
    await b.connect();
    await join(b);
    b.kill();
    await until(() => h!.relay.stats().agents === 1);
    expect((await a.post('/relay/v1/reply', roomEnv(a, 'r-1'))).status).toBe(400);
    expect((await post(a, 'd-1')).body.queued).toBe(1);
    expect((await post(a, 'd-1')).status).toBe(409);
  });
});

describe('relay rooms: offline members, TTL, bounds', () => {
  it('a member offline at post time gets it on reconnect, in order, after a membership snapshot', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    const c = await h.agent(2).connect();
    for (const x of [a, b, c]) await join(x);
    c.kill();
    await until(() => h!.relay.stats().agents === 2);
    expect((await post(a, 'o-1', 1)).body).toMatchObject({ delivered: 1, queued: 1 });
    expect((await post(b, 'o-2', 2)).body).toMatchObject({ delivered: 1, queued: 1 });
    expect(h.relay.stats().memberships).toBe(3); // offline is still a member

    const c2 = await h.agent(2).connect();
    await until(() => envelopes(c2).length === 2);
    expect(envelopes(c2).map((e) => e.data.msgId)).toEqual(['o-1', 'o-2']);
    const snap = c2.events.findIndex((e) => e.event === 'room_snapshot');
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(snap).toBeLessThan(c2.events.findIndex((e) => e.event === 'envelope'));
    expect(c2.events[snap].data).toEqual({ room: ROOM, members: [a.fp, b.fp, c2.fp] });
  });

  it('an unacked room post is redelivered if the member\'s stream dies', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    await join(a);
    await join(b);
    await post(a, 'redo-1');
    await b.waitFor((e) => e.event === 'envelope');
    b.kill();
    await until(() => h!.relay.stats().agents === 1);
    expect(h.relay.stats()).toMatchObject({ roomInflight: 0, queued: 1 });
    const b2 = await h.agent(1).connect();
    const ev = await b2.waitFor((e) => e.event === 'envelope');
    expect(ev.data.msgId).toBe('redo-1');
  });

  it('TTL expiry drops a queued room post and reports it to the sender, naming the member and room', async () => {
    h = await startRelay({ queueTtlMs: 60_000 }, { fakeClock: true });
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    await join(a);
    await b.connect();
    await join(b);
    b.kill();
    await until(() => h!.relay.stats().agents === 1);
    expect((await post(a, 'ttl-1')).body.queued).toBe(1);
    h.clock.t += 61_000;
    h.relay.sweep();
    const ev = await a.waitFor((e) => e.event === 'dropped');
    expect(ev.data).toMatchObject({ msgId: 'ttl-1', to: b.fp, room: ROOM });
    expect(ev.data.reason).toMatch(/expired/);
    expect(h.relay.stats().queued).toBe(0);
    const b2 = await h.agent(1).connect();
    await sleep(50);
    expect(envelopes(b2)).toHaveLength(0);
  });

  it('the per-member bound applies per member: a full mailbox drops only that member\'s copy', async () => {
    h = await startRelay({ maxQueuedPerDestination: 2 });
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    const c = await h.agent(2).connect();
    for (const x of [a, b, c]) await join(x);
    c.kill();
    await until(() => h!.relay.stats().agents === 2);
    // b acks as it goes, c is offline and fills up.
    for (let i = 0; i < 2; i++) {
      expect((await post(a, `f-${i}`)).body.dropped).toEqual([]);
      const ev = await b.waitFor((e) => e.event === 'envelope' && e.data.msgId === `f-${i}`);
      expect((await ack(b, ev.data)).status).toBe(200);
    }
    expect(h.relay.stats().roomInflight).toBe(0);
    const r = await post(a, 'f-2');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ delivered: 1, queued: 0, dropped: [{ to: c.fp, reason: 'queue_full' }] });
    expect(h.logs.some((l) => l.includes('"reason":"queue_full"'))).toBe(true);
  });
});

describe('relay rooms: leave and membership events', () => {
  it('join and leave reach the other members; leave stops delivery; rejoin restores it', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    const c = await h.agent(2).connect();
    expect((await join(a)).body).toEqual({ room: ROOM, members: [a.fp], joined: true });
    await join(b);
    expect((await a.waitFor((e) => e.event === 'room_member')).data).toEqual({ room: ROOM, fingerprint: b.fp, change: 'joined' });
    const jc = await join(c);
    expect(jc.body.members).toEqual([a.fp, b.fp, c.fp]);
    for (const x of [a, b]) await x.waitFor((e) => e.event === 'room_member' && e.data.fingerprint === c.fp && e.data.change === 'joined');
    expect(c.events.some((e) => e.event === 'room_member' && e.data.fingerprint === c.fp)).toBe(false); // not told about itself
    expect((await join(c)).body.joined).toBe(false); // idempotent

    expect((await leave(c)).status).toBe(200);
    for (const x of [a, b]) await x.waitFor((e) => e.event === 'room_member' && e.data.fingerprint === c.fp && e.data.change === 'left');
    const r = await post(a, 'after-leave');
    expect(r.body).toMatchObject({ delivered: 1, queued: 0 });
    await b.waitFor((e) => e.event === 'envelope');
    await sleep(50);
    expect(envelopes(c)).toHaveLength(0);
    expect((await leave(c)).status).toBe(404);
    expect((await post(c, 'gone')).status).toBe(403);
  });

  it('leaving discards that member\'s queued copies; the last member leaving removes the room', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = h.agent(1);
    await join(a);
    await b.connect();
    await join(b);
    b.kill();
    await until(() => h!.relay.stats().agents === 1);
    await post(a, 'q-1');
    expect(h.relay.stats().queued).toBe(1);
    const b2 = await h.agent(1).connect();
    // Leave races the flush; whichever wins, b2 must not be left holding state.
    await leave(b2);
    expect(h.relay.stats()).toMatchObject({ queued: 0, roomInflight: 0, rooms: 1, memberships: 1 });
    await leave(a);
    expect(h.relay.stats()).toMatchObject({ rooms: 0, memberships: 0 });
  });
});

describe('relay rooms: single-recipient delivery unchanged', () => {
  it('a direct send between two room members still works exactly as before', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    await join(a);
    await join(b);
    b.onEnvelope = (p) => ({ method: '200', path: '', headers: {}, body: { echo: (p.body as any).text } });
    const r = await a.send(b, 'direct-1', payload(7));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('delivered');
    expect(a.open(b, r.body.reply).body).toEqual({ echo: `${TEXT} #7` });
  });
});

describe('relay rooms: never sees plaintext', () => {
  it('token and text are absent from everything the relay receives, stores and logs; room ids are only logged as prefixes', async () => {
    h = await startRelay();
    wireLog.length = 0;
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    const c = h.agent(2);
    for (const x of [a, b]) await join(x);
    await c.connect();
    await join(c);
    c.kill();
    await until(() => h!.relay.stats().agents === 2);
    await post(a, 'pt-1', 1);
    const stored = h.relay.dumpState(); // includes c's queued copy
    expect(stored).toContain('pt-1');
    const c2 = await h.agent(2).connect();
    await c2.waitFor((e) => e.event === 'envelope');
    await post(b, 'pt-2', 2);
    await c2.waitFor((e) => e.event === 'envelope' && e.data.msgId === 'pt-2');
    expect((openEnvelope(roomKey, envelopes(c2)[1].data) as any).body.text).toBe(`${TEXT} #2`);

    const everything = [...wireLog, stored, h.relay.dumpState(), ...h.logs, JSON.stringify(a.events), JSON.stringify(b.events), JSON.stringify(c2.events)].join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(TEXT);
    expect(everything).not.toContain(Buffer.from(TEXT).toString('base64').slice(0, 20));
    expect(everything).not.toContain(roomKey.toString('base64'));
    const logs = h.logs.join('\n');
    expect(logs).toContain('"event":"room_posted"');
    expect(logs).not.toContain(ROOM);
    expect(logs).toContain(`"room":"${ROOM.slice(0, 6)}"`);
  });

  it('join accepts only {room}: nothing else can ride along', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const r = await a.post('/relay/v1/rooms/join', { room: ROOM, key: roomKey.toString('base64') });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('bad_room');
    expect((await a.post('/relay/v1/rooms/join', { room: 'short' })).status).toBe(400);
    expect((await a.post('/relay/v1/send', { ...roomEnv(a, 'z'), to: 'room:bad id!' })).status).toBe(400);
    expect(h.relay.stats().rooms).toBe(0);
  });
});

describe('relay rooms: limits', () => {
  it('too many members', async () => {
    h = await startRelay({ maxMembersPerRoom: 2 });
    const [a, b, c] = [await h.agent(0).connect(), await h.agent(1).connect(), await h.agent(2).connect()];
    await join(a);
    await join(b);
    const r = await join(c);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('room_full');
    expect(r.body.error.message).toMatch(/2 members/);
  });

  it('too many rooms per agent, and per relay', async () => {
    h = await startRelay({ maxRoomsPerAgent: 1, maxRooms: 2 });
    const [a, b, c] = [await h.agent(0).connect(), await h.agent(1).connect(), await h.agent(2).connect()];
    await join(a, ROOM);
    const r = await join(a, ROOM2);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('too_many_rooms');
    await join(b, ROOM2);
    const r2 = await join(c, 'third-' + crypto.randomBytes(12).toString('hex'));
    expect(r2.status).toBe(507);
    expect(r2.body.error.code).toBe('relay_rooms_full');
    expect((await join(c, ROOM)).status).toBe(200); // existing rooms still joinable
  });

  it('oversized room post is 413', async () => {
    h = await startRelay({ maxEnvelopeBytes: 4096 });
    const a = await h.agent(0).connect();
    await join(a);
    const r = await a.post('/relay/v1/send', { to: `room:${ROOM}`, from: a.fp, msgId: 'big', ...sealEnvelope(roomKey, { method: 'POST', path: '/', headers: {}, body: 'x'.repeat(10_000) }) });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('too_large');
  });

  it('a room post counts once against the sender\'s rate limit', async () => {
    h = await startRelay({ sendsPerMinutePerAgent: 2 });
    const a = await h.agent(0).connect();
    await join(a); // 1
    expect((await post(a, 'rl-1')).status).toBe(202); // 2
    expect((await post(a, 'rl-2')).status).toBe(429);
  });
});

describe('relay rooms: authentication', () => {
  it('an unauthenticated agent cannot join, post, ack or receive', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    await join(a);
    const m = h.agent(1);
    await m.openStream(); // stream open, never authenticated
    const room = { room: ROOM };
    expect((await request(h.port, 'POST', '/relay/v1/rooms/join', room)).status).toBe(401);
    expect((await request(h.port, 'POST', '/relay/v1/rooms/join', room, { Authorization: 'Bearer not-a-session' })).status).toBe(401);
    expect((await request(h.port, 'POST', '/relay/v1/send', roomEnv(m, 'u-1'))).status).toBe(401);
    expect((await request(h.port, 'POST', '/relay/v1/ack', { room: ROOM, sender: a.fp, msgId: 'x' })).status).toBe(401);
    expect(h.relay.stats().memberships).toBe(1);
    expect((await post(a, 'u-2')).body).toMatchObject({ delivered: 0, queued: 0 });
    await sleep(50);
    expect(envelopes(m)).toHaveLength(0);
    expect(m.events.every((e) => e.event === 'challenge')).toBe(true);
  });

  it('a replaced (stale) session cannot join', async () => {
    h = await startRelay();
    const a1 = await h.agent(0).connect();
    await h.agent(0).connect();
    await a1.waitFor((e) => e.event === 'replaced');
    expect((await join(a1)).status).toBe(401);
  });
});

describe('relay rooms: health', () => {
  it('health reports room and membership counts and no room ids', async () => {
    h = await startRelay();
    const a = await h.agent(0).connect();
    const b = await h.agent(1).connect();
    await join(a);
    await join(b);
    await join(a, ROOM2);
    const r = await request(h.port, 'GET', '/relay/v1/health');
    expect(r.body).toMatchObject({ ok: true, rooms: 2, memberships: 3 });
    expect(JSON.stringify(r.body)).not.toContain(ROOM.slice(0, 6));
  });
});
