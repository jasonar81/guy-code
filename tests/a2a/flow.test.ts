// @vitest-environment node
/**
 * A2A P2 acceptance tests (docs/a2a/DESIGN.md section 10, P2), written as the
 * acceptance criteria. Two real A2ANodes on 127.0.0.1 ephemeral ports with
 * real TLS and freshly generated certificates; nothing is mocked between
 * them. The model is a script that returns tool calls (agentHarness.ts) and
 * the tools are the real A2A_TOOLS.
 *
 * Jason's node asks Dylan's; Dylan's user approves; Dylan's agent answers
 * WORKING, then COMPLETED; Jason's session sleeps in WaitForA2A in between
 * and must not make a single model call until the COMPLETED push wakes it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { connectPinned } from '../../electron/a2a/tls';
import { setA2ANodeResolver } from '../../electron/a2aTools';
import { RETRY } from '../../electron/a2a/push';
import { makeNode, pair, restartNode, stopNode, type TestNode } from './helpers';
import { AgentHarness, type Script, type ToolCall } from './agentHarness';

const live: TestNode[] = [];
afterEach(async () => {
  while (live.length) await live.pop()!.node.stop().catch(() => {});
  setA2ANodeResolver(null);
});

/** Two harnessed nodes, paired. Jason = requester, Dylan = remote. */
async function world(opts: { jasonScript: Script; dylanScript: Script; paused?: () => boolean }) {
  const hj = new AgentHarness(opts.jasonScript);
  const hd = new AgentHarness(opts.dylanScript);
  hj.addSession('j1', 'perf work');
  hd.addSession('d1', 'ja-sql1 tests');
  const approvals: string[] = [];
  const jason = await makeNode({ name: 'Jason', certIndex: 0, extra: { sessions: hj.port, waits: hj.waits } });
  const dylan = await makeNode({
    name: 'Dylan',
    certIndex: 1,
    extra: { sessions: hd.port, waits: hd.waits, isPaused: opts.paused, onApprovalNeeded: (t) => void approvals.push(t.task_id) },
  });
  live.push(jason, dylan);
  hj.node = jason.node;
  hd.node = dylan.node;
  await pair(jason, dylan); // jason invites, dylan redeems: jason sees "dylan", dylan sees "jason"
  return { hj, hd, jason, dylan, approvals };
}

/** Scripted model for Jason's side of design 8.2. */
function jasonScript(): Script {
  return (_sid, h): ToolCall[] => {
    if (h.input.startsWith('Have Dylan')) {
      if (!h.results.length) {
        return [{ tool: 'A2ARequest', input: { peer: 'dylan', kind: 'notify', text: 'Please notify Jason when your ja-sql1 test is done.' } }];
      }
      if (h.results.length === 1) {
        const id = /taskId (\S+),/.exec(h.results[0].result)![1];
        return [{ tool: 'WaitForA2A', input: { taskIds: [id], timeoutMs: 4 * 3_600_000 } }];
      }
    }
    return []; // woken: "run the perf test" (no further tool calls in this script)
  };
}

/** Dylan's agent: on the envelope, reply working; when told "test done", complete. */
function dylanScript(): Script {
  return (_sid, h): ToolCall[] => {
    const task = /task ([0-9a-f-]{36})/.exec(h.input)?.[1];
    if (task && !h.results.length) return [{ tool: 'A2AReply', input: { taskId: task, action: 'working', text: 'watching: bench_p5.py on ja-sql1' } }];
    const done = /^test done (\S+)/.exec(h.input);
    if (done && !h.results.length) {
      return [{ tool: 'A2AReply', input: { taskId: done[1], action: 'complete', text: 'bench_p5.py exited; test_foo passed (12m31s), system idle' } }];
    }
    return [];
  };
}

const flushBoth = async (w: { jason: TestNode; dylan: TestNode; hj: AgentHarness; hd: AgentHarness }) => {
  for (let i = 0; i < 3; i++) {
    await w.dylan.node.flushOutbox();
    await w.jason.node.flushOutbox();
    await w.hd.idle();
    await w.hj.idle();
  }
};

describe('design 8.2 end to end: notify -> approve -> WORKING -> COMPLETED wakes the waiter', () => {
  it('runs the whole flow with zero model calls while waiting', async () => {
    const w = await world({ jasonScript: jasonScript(), dylanScript: dylanScript() });
    const { hj, hd, jason, dylan, approvals } = w;

    // 1. Jason's user asks; the model calls A2ARequest(kind=notify) then WaitForA2A.
    await hj.userTurn('j1', 'Have Dylan\'s agent tell us when his ja-sql1 test is done, then run our perf test on a quiet system.');
    expect(hj.toolLog.map((t) => t.tool)).toEqual(['A2ARequest', 'WaitForA2A']);
    expect(hj.sessions.get('j1')!.row.state).toBe('sleeping-tool');
    const callsAtSleep = hj.callsFor('j1');
    const out = jason.node.store.listTasks({ direction: 'out' })[0];
    expect(out.kind).toBe('notify');
    expect(out.push_token_hash).toMatch(/^[0-9a-f]{64}$/); // only a hash of the per-task token is stored

    // 2. Dylan's side: Jason is at inform trust, so it waits for Dylan's approval.
    const inT = dylan.node.store.listTasks({ direction: 'in' })[0];
    expect(inT.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(approvals).toEqual([inT.task_id]);
    expect(hd.modelCalls).toHaveLength(0); // nothing reached Dylan's session yet
    // The approval INPUT_REQUIRED push reached Jason but must not wake him.
    await flushBoth(w);
    expect(jason.node.store.getTask(out.task_id)!.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(hj.sessions.get('j1')!.row.state).toBe('sleeping-tool');

    // 3. Dylan accepts; his agent replies WORKING -> push -> Jason keeps sleeping.
    dylan.node.accept(inT.task_id);
    await flushBoth(w);
    expect(hd.toolLog.map((t) => t.tool)).toEqual(['A2AReply']);
    expect(jason.node.store.getTask(out.task_id)!.state).toBe('TASK_STATE_WORKING');
    expect(hj.sessions.get('j1')!.row.state).toBe('sleeping-tool');
    expect(hj.sessions.get('j1')!.wait).not.toBeNull();

    // 4. The test finishes on Dylan's side; his agent completes with the outcome.
    await hd.userTurn('d1', `test done ${inT.task_id}`);
    expect(dylan.node.store.getTask(inT.task_id)!.state).toBe('TASK_STATE_COMPLETED');
    // Zero model calls on Jason's side between WaitForA2A and the wake (acceptance 7).
    expect(hj.callsFor('j1')).toBe(callsAtSleep);
    await flushBoth(w);

    // 5. Jason wakes with the artifact in the resume note.
    const wake = hj.modelCalls.filter((m) => m.sessionId === 'j1').at(-1)!;
    expect(wake.input).toMatch(/^\[WaitForA2A\] dylan's task [0-9a-f]{8} "Please notify Jason when your ja-sql1 test is done\." -> COMPLETED: ".*test_foo passed \(12m31s\), system idle/);
    expect(hj.callsFor('j1')).toBe(callsAtSleep + 1);
    expect(hj.sessions.get('j1')!.wait).toBeNull();
    const done = jason.node.store.getTask(out.task_id)!;
    expect(done.state).toBe('TASK_STATE_COMPLETED');
    expect(JSON.parse(done.artifacts_json!)[0].parts[0].text).toMatch(/test_foo passed/);
  });

  it('a lost push is caught by the poll backstop (GET /tasks/{id}) on the timer wake', async () => {
    const w = await world({ jasonScript: jasonScript(), dylanScript: dylanScript() });
    const { hj, hd, jason, dylan } = w;
    // Dylan is already collaborate, so no approval step.
    dylan.node.setTrust('jason', 'collaborate');
    await hj.userTurn('j1', 'Have Dylan\'s agent tell us when his ja-sql1 test is done.');
    await hd.idle();
    const inT = dylan.node.store.listTasks({ direction: 'in' })[0];
    expect(inT.state).toBe('TASK_STATE_WORKING');
    await hd.userTurn('d1', `test done ${inT.task_id}`);
    // Every push is lost: the outbox is wiped before it is flushed.
    for (const r of dylan.node.store.listOutbox()) dylan.node.store.deleteOutbox(r.id);
    const out = jason.node.store.listTasks({ direction: 'out' })[0];
    expect(jason.node.store.getTask(out.task_id)!.state).not.toBe('TASK_STATE_COMPLETED');
    const before = hj.callsFor('j1');

    // An early timer wake: the task is not stale yet, so no poll and no model call.
    expect(await hj.timerWake('j1', Date.now())).toBe('slept');
    expect(hj.callsFor('j1')).toBe(before);

    // 10 minutes of silence later the backstop polls Dylan and wakes Jason.
    jason.clock.now += 11 * 60_000;
    expect(await hj.timerWake('j1', jason.clock.now)).toBe('resumed');
    expect(hj.modelCalls.at(-1)!.input).toMatch(/-> COMPLETED: ".*test_foo passed/);
    expect(jason.node.audit.tail().some((e) => e.event === 'poll.result' && e.state === 'TASK_STATE_COMPLETED')).toBe(true);
  });

  it('restart mid-wait: the sweep after a restart resumes the waiter', async () => {
    const w = await world({ jasonScript: jasonScript(), dylanScript: dylanScript() });
    const { hj, hd, dylan } = w;
    dylan.node.setTrust('jason', 'collaborate');
    await hj.userTurn('j1', 'Have Dylan\'s agent tell us when his ja-sql1 test is done.');
    await hd.idle();
    const inT = dylan.node.store.listTasks({ direction: 'in' })[0];
    // Jason's app goes down. Dylan completes; the push cannot be delivered.
    await stopNode(w.jason);
    await hd.userTurn('d1', `test done ${inT.task_id}`);
    await dylan.node.flushOutbox();
    expect(dylan.node.store.listOutbox().length).toBe(1); // persisted for retry
    // Jason restarts on the same DB, port and cert. The wait is still recorded.
    const j2 = await restartNode(w.jason, 'Jason', 0, { sessions: hj.port, waits: hj.waits });
    live.push(j2);
    hj.node = j2.node;
    expect(hj.sessions.get('j1')!.wait).not.toBeNull();
    // The governor sweep (startup) runs the timer path: still nothing new and not stale -> sleep again.
    expect(await hj.timerWake('j1', j2.clock.now)).toBe('slept');
    // Dylan's retry, now that Jason is back, is the push that wakes him.
    dylan.clock.now += RETRY.fastDelaysMs[0] + 1;
    await dylan.node.flushOutbox();
    await hj.idle();
    expect(hj.modelCalls.at(-1)!.input).toMatch(/-> COMPLETED/);
    expect(hj.sessions.get('j1')!.wait).toBeNull();
  });

  it('a new user turn cancels wait_a2a, and a later push does not resume the session', async () => {
    const w = await world({ jasonScript: jasonScript(), dylanScript: dylanScript() });
    const { hj, hd, dylan } = w;
    dylan.node.setTrust('jason', 'collaborate');
    await hj.userTurn('j1', 'Have Dylan\'s agent tell us when his ja-sql1 test is done.');
    await hd.idle();
    expect(hj.sessions.get('j1')!.wait).not.toBeNull();
    await hj.userTurn('j1', 'never mind, do something else');
    expect(hj.sessions.get('j1')!.wait).toBeNull();
    const calls = hj.callsFor('j1');
    const inT = dylan.node.store.listTasks({ direction: 'in' })[0];
    await hd.userTurn('d1', `test done ${inT.task_id}`);
    await flushBoth(w);
    expect(hj.callsFor('j1')).toBe(calls); // the COMPLETED push updated the task but woke nobody
  });
});

// ---------------------------------------------------------------------------

/** Raw POST /a2a-push as `from` (bearer = from's token for `to`). */
async function rawPush(to: TestNode, bearer: string, body: unknown, pushToken?: string): Promise<{ status: number; body: any }> {
  const u = new URL(to.node.origin());
  const sock = await connectPinned({ host: u.hostname, port: Number(u.port), fingerprint: to.node.fingerprint() });
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        path: '/a2a-push',
        createConnection: () => sock,
        headers: {
          'A2A-Version': '1.0',
          Authorization: `Bearer ${bearer}`,
          'Content-Type': 'application/a2a+json',
          'Content-Length': payload.length,
          ...(pushToken ? { 'X-A2A-Notification-Token': pushToken } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('push in: replay, forgery and idempotency (design 4.2.5)', () => {
  /** Jason asks Dylan (collaborate); capture the per-task token Dylan holds. */
  async function setup() {
    const jason = await makeNode({ name: 'Jason', certIndex: 0 });
    const dylan = await makeNode({ name: 'Dylan', certIndex: 1 });
    const third = await makeNode({ name: 'Priya', certIndex: 2 });
    live.push(jason, dylan, third);
    await pair(jason, dylan);
    await pair(jason, third);
    dylan.node.setTrust('jason', 'collaborate');
    const r = await jason.node.request({ peer: 'dylan', kind: 'request', text: 'which branch is the H3 fix on?' });
    const cfg = dylan.node.store.getPushConfigs(r.taskId)[0];
    const pushToken = dylan.node.store.getPushToken(cfg)!;
    const dylanBearer = dylan.secrets.get('a2a.peer.jason.tokenOut')!;
    const priyaBearer = third.secrets.get('a2a.peer.jason.tokenOut')!;
    const snap = (state: string, ts: string, text = 'x') => ({
      task: { id: r.taskId, contextId: r.contextId, status: { state, timestamp: ts, message: { messageId: `m-${ts}`, role: 'ROLE_AGENT', parts: [{ text }] } } },
    });
    return { jason, dylan, taskId: r.taskId, pushToken, dylanBearer, priyaBearer, snap };
  }

  it('the push config is the flat v1.0 shape, aimed at our own endpoint, and no plaintext token is stored in the DB', async () => {
    const { jason, dylan, taskId, pushToken } = await setup();
    const row = dylan.sql.prepare('SELECT * FROM a2a_push_configs WHERE task_id = ?').get<any>(taskId)!;
    expect(row.url).toBe('/a2a-push');
    expect(row.token).toBeNull();
    expect(JSON.stringify(row)).not.toContain(pushToken);
    const req = JSON.parse(jason.node.store.getTask(taskId)!.request_json!);
    expect(req.metadata.kind).toBe('request');
    expect(JSON.stringify(jason.sql.prepare('SELECT * FROM a2a_tasks').all())).not.toContain(pushToken);
  });

  it('a duplicate push is idempotent: applied once, wakes once', async () => {
    const { jason, taskId, pushToken, dylanBearer, snap } = await setup();
    const woke: string[] = [];
    (jason.node.waiters as any).port = { listWaiting: () => [{ sessionId: 's', state: { taskIds: [taskId], peer: null, contextId: null, states: null, deadlineTs: Date.now() + 1e9, pollStaleMs: 6e5, startedTs: 0 } }], resume: (s: string) => woke.push(s) };
    const body = snap('TASK_STATE_COMPLETED', '2030-01-01T00:00:01.000Z', 'main');
    const a = await rawPush(jason, dylanBearer, body, pushToken);
    const b = await rawPush(jason, dylanBearer, body, pushToken);
    expect(a).toMatchObject({ status: 200, body: { accepted: true } });
    expect(b).toMatchObject({ status: 200, body: { accepted: false } });
    expect(woke).toEqual(['s']);
  });

  it('a terminal task never reopens, and an older snapshot cannot move it back', async () => {
    const { jason, taskId, pushToken, dylanBearer, snap } = await setup();
    await rawPush(jason, dylanBearer, snap('TASK_STATE_WORKING', '2030-01-01T00:00:02.000Z'), pushToken);
    const stale = await rawPush(jason, dylanBearer, snap('TASK_STATE_WORKING', '2030-01-01T00:00:01.000Z', 'old'), pushToken);
    expect(stale.body.accepted).toBe(false);
    await rawPush(jason, dylanBearer, snap('TASK_STATE_COMPLETED', '2030-01-01T00:00:03.000Z'), pushToken);
    const reopen = await rawPush(jason, dylanBearer, snap('TASK_STATE_WORKING', '2030-01-01T00:00:09.000Z'), pushToken);
    expect(reopen.body.accepted).toBe(false);
    expect(jason.node.store.getTask(taskId)!.state).toBe('TASK_STATE_COMPLETED');
  });

  it('a push with the wrong (or no) per-task token is rejected', async () => {
    const { jason, taskId, dylanBearer, snap } = await setup();
    const wrong = await rawPush(jason, dylanBearer, snap('TASK_STATE_COMPLETED', '2030-01-01T00:00:01.000Z'), 'not-the-token');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.details[0].reason).toBe('PUSH_TOKEN_MISMATCH');
    const none = await rawPush(jason, dylanBearer, snap('TASK_STATE_COMPLETED', '2030-01-01T00:00:01.000Z'));
    expect(none.status).toBe(403);
    expect(jason.node.store.getTask(taskId)!.state).not.toBe('TASK_STATE_COMPLETED');
  });

  it('a push for a task we did not create on THAT peer is rejected, even with the right token', async () => {
    const { jason, taskId, pushToken, priyaBearer, snap } = await setup();
    // Priya is paired with Jason and somehow learned the token: still refused, it is Dylan's task.
    const r = await rawPush(jason, priyaBearer, snap('TASK_STATE_COMPLETED', '2030-01-01T00:00:01.000Z'), pushToken);
    expect(r.status).toBe(404);
    expect(r.body.error.details[0].reason).toBe('TASK_NOT_FOUND');
    expect(jason.node.store.getTask(taskId)!.state).not.toBe('TASK_STATE_COMPLETED');
    expect(jason.node.audit.tail().some((e) => e.event === 'push.rejected')).toBe(true);
  });

  it('a push for an INBOUND task id (one the peer created on us) is rejected', async () => {
    const { jason, dylan, dylanBearer } = await setup();
    const sent = await dylan.node.send({ peer: 'jason', text: 'fyi' });
    const r = await rawPush(jason, dylanBearer, { task: { id: sent.taskId, contextId: '', status: { state: 'TASK_STATE_FAILED' } } }, 'x');
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('approval gating (design 6.3 step 4)', () => {
  it('request from an inform peer does not reach the session until accepted; Accept delivers and pushes WORKING', async () => {
    const w = await world({ jasonScript: () => [], dylanScript: () => [] });
    const r = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'please run the migration' });
    await w.hd.idle();
    expect(w.hd.modelCalls).toHaveLength(0);
    expect(w.dylan.node.pendingApprovals().map((t) => t.task_id)).toEqual([r.taskId]);
    w.dylan.node.accept(r.taskId.slice(0, 8)); // short ids work, as in Slack / the panel
    await w.hd.idle();
    expect(w.hd.modelCalls).toHaveLength(1);
    expect(w.hd.modelCalls[0].input).toMatch(/^\[A2A message from jason \(Jason, Guy Code\) · trust: inform · task /);
    expect(w.hd.modelCalls[0].input).toMatch(/This is a REQUEST from jason's agent[\s\S]*A2AReply/);
    await w.dylan.node.flushOutbox();
    expect(w.jason.node.store.getTask(r.taskId)!.state).toBe('TASK_STATE_WORKING');
  });

  it('Decline sets the task to REJECTED on both sides and never reaches a session', async () => {
    const w = await world({ jasonScript: () => [], dylanScript: () => [] });
    const r = await w.jason.node.request({ peer: 'dylan', kind: 'notify', text: 'tell me when the build is green' });
    w.dylan.node.decline(r.taskId, { reason: 'busy today' });
    await w.dylan.node.flushOutbox();
    expect(w.dylan.node.store.getTask(r.taskId)!.state).toBe('TASK_STATE_REJECTED');
    const j = w.jason.node.store.getTask(r.taskId)!;
    expect(j.state).toBe('TASK_STATE_REJECTED');
    expect(j.last_status_json).toMatch(/busy today/);
    expect(w.hd.modelCalls).toHaveLength(0);
    expect(() => w.dylan.node.accept(r.taskId)).toThrow(/not waiting for approval/);
  });

  it('collaborate delivers at once (WORKING); inform messages are always delivered', async () => {
    const w = await world({ jasonScript: () => [], dylanScript: () => [] });
    w.dylan.node.setTrust('jason', 'collaborate');
    const r = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'q' });
    expect(r.state).toBe('TASK_STATE_WORKING');
    await w.hd.idle();
    expect(w.hd.modelCalls).toHaveLength(1);
  });

  it('pause caps effective trust at inform: a collaborate peer\'s request is held again', async () => {
    let paused = false;
    const w = await world({ jasonScript: () => [], dylanScript: () => [], paused: () => paused });
    w.dylan.node.setTrust('jason', 'collaborate');
    paused = true;
    const r = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'q' });
    expect(r.state).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(w.dylan.node.store.getPeer('jason')!.trust).toBe('collaborate'); // configured level is kept
    paused = false;
    const r2 = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'q2' });
    expect(r2.state).toBe('TASK_STATE_WORKING');
  });

  it('time-boxed trust reverts at expiry (to trust_prev), audited, and gates at the reverted level', async () => {
    const w = await world({ jasonScript: () => [], dylanScript: () => [] });
    w.dylan.node.setTrust('jason', 'full', { expiresAt: w.dylan.clock.now + 60_000 });
    const before = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'a' });
    expect(before.state).toBe('TASK_STATE_WORKING');
    w.dylan.clock.now += 61_000;
    const after = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'b' });
    expect(after.state).toBe('TASK_STATE_INPUT_REQUIRED');
    const p = w.dylan.node.store.getPeer('jason')!;
    expect(p.trust).toBe('inform');
    expect(p.trust_expires_ts).toBeNull();
    expect(w.dylan.node.audit.tail().some((e) => e.event === 'trust.expired' && e.from === 'full' && e.to === 'inform')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('outbox (design 6.6)', () => {
  it('peer offline: queued, retried with backoff, delivered when it comes back; the tool says so', async () => {
    const hj = new AgentHarness(() => []);
    hj.addSession('j1', 'x');
    const jason = await makeNode({ name: 'Jason', certIndex: 0, extra: { sessions: hj.port, waits: hj.waits } });
    let dylan = await makeNode({ name: 'Dylan', certIndex: 1 });
    live.push(jason, dylan);
    hj.node = jason.node;
    await pair(jason, dylan);
    await stopNode(dylan);

    setA2ANodeResolver(async () => jason.node);
    const { A2A_TOOLS } = await import('../../electron/a2aTools');
    const out = await A2A_TOOLS.A2ASend.execute({ peer: 'dylan', text: 'heads up: retry policy is changing' }, { sessionId: 'j1', cwd: '' });
    expect(out).toMatch(/dylan's agent is offline; queued, will retry for 24h/);
    const req = await A2A_TOOLS.A2ARequest.execute({ peer: 'dylan', kind: 'notify', text: 'tell us when done' }, { sessionId: 'j1', cwd: '' });
    expect(req).toMatch(/queued, will retry for 24h/);
    expect(jason.node.store.listOutbox('dylan')).toHaveLength(2);

    // Still offline: an attempt fails and backs off (2s -> 8s ...).
    jason.clock.now += RETRY.fastDelaysMs[0] + 1;
    await jason.node.flushOutbox();
    const rows = jason.node.store.listOutbox('dylan');
    // The inline attempt in the tool was #1, this retry is #2: next in 8s.
    expect(rows.map((r) => [r.attempts, r.next_try_ts - jason.clock.now])).toEqual([
      [2, RETRY.fastDelaysMs[1]],
      [2, RETRY.fastDelaysMs[1]],
    ]);

    // Dylan comes back; the next retry delivers both, exactly once.
    dylan = await restartNode(dylan, 'Dylan', 1);
    live.push(dylan);
    jason.clock.now += RETRY.fastDelaysMs[1] + 1;
    await jason.node.flushOutbox();
    expect(jason.node.store.listOutbox('dylan')).toHaveLength(0);
    expect(dylan.port.delivered()).toHaveLength(1); // the inform; the notify waits for Dylan's approval
    expect(dylan.node.pendingApprovals()).toHaveLength(1);
    // The placeholder became the real task id, with the push token hash intact.
    const outs = jason.node.store.listTasks({ direction: 'out' });
    expect(outs.some((t) => t.task_id.startsWith('queued-'))).toBe(false);
    expect(outs.find((t) => t.kind === 'notify')!.push_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives up after 24h and marks the queued task FAILED (which wakes a waiter)', async () => {
    const jason = await makeNode({ name: 'Jason', certIndex: 0 });
    const dylan = await makeNode({ name: 'Dylan', certIndex: 1 });
    live.push(jason, dylan);
    await pair(jason, dylan);
    await stopNode(dylan);
    const r = await jason.node.request({ peer: 'dylan', kind: 'request', text: 'q' });
    expect(r.queued).toBe(true);
    jason.clock.now += RETRY.windowMs + 1;
    await jason.node.flushOutbox();
    expect(jason.node.store.listOutbox()).toHaveLength(0);
    expect(jason.node.store.getTask(r.taskId)!.state).toBe('TASK_STATE_FAILED');
  });

  it('push retry schedule: 5 fast attempts, then hourly for terminal states only, inside 24h', async () => {
    const { nextRetryTs } = await import('../../electron/a2a/push');
    const t0 = 1_000_000;
    expect([1, 2, 3, 4, 5].map((f) => nextRetryTs('push', false, f, t0, t0 + RETRY.windowMs)! - t0)).toEqual([2_000, 8_000, 30_000, 120_000, 120_000]);
    expect(nextRetryTs('push', false, 6, t0, t0 + RETRY.windowMs)).toBeNull(); // WORKING: the requester's poll covers it
    expect(nextRetryTs('push', true, 6, t0, t0 + RETRY.windowMs)! - t0).toBe(3_600_000);
    expect(nextRetryTs('push', true, 30, t0 + RETRY.windowMs - 10, t0 + RETRY.windowMs)).toBeNull();
  });

  it('a terminal push survives a restart of the SENDER (persisted outbox)', async () => {
    let jason = await makeNode({ name: 'Jason', certIndex: 0 });
    let dylan = await makeNode({ name: 'Dylan', certIndex: 1 });
    live.push(jason, dylan);
    await pair(jason, dylan);
    dylan.node.setTrust('jason', 'collaborate');
    const r = await jason.node.request({ peer: 'dylan', kind: 'request', text: 'q' });
    await stopNode(jason);
    dylan.node.reply({ taskId: r.taskId, action: 'complete', text: 'answer: main' });
    await dylan.node.flushOutbox(); // fails: Jason is down
    dylan = await restartNode(dylan, 'Dylan', 1); // Dylan's app restarts too
    live.push(dylan);
    jason = await restartNode(jason, 'Jason', 0);
    live.push(jason);
    dylan.clock.now += 10 * 60_000;
    await dylan.node.flushOutbox();
    expect(jason.node.store.getTask(r.taskId)!.state).toBe('TASK_STATE_COMPLETED');
  });
});

// ---------------------------------------------------------------------------

describe('ListTasks, cancel and reply rules', () => {
  it('GET /tasks lists only the caller\'s own tasks, paged', async () => {
    const jason = await makeNode({ name: 'Jason', certIndex: 0 });
    const dylan = await makeNode({ name: 'Dylan', certIndex: 1 });
    const priya = await makeNode({ name: 'Priya', certIndex: 2 });
    live.push(jason, dylan, priya);
    await pair(dylan, jason);
    await pair(dylan, priya);
    for (let i = 0; i < 3; i++) await jason.node.send({ peer: 'dylan', text: `j${i}` });
    await priya.node.send({ peer: 'dylan', text: 'p' });
    const { a2aRequest } = await import('../../electron/a2a/client');
    const ep = { baseUrl: new URL(dylan.node.origin()).origin, certSha256: dylan.node.fingerprint(), token: jason.secrets.get('a2a.peer.dylan.tokenOut')! };
    const page1 = await a2aRequest<any>(ep, 'GET', '/tasks?pageSize=2');
    expect(page1.tasks).toHaveLength(2);
    expect(page1.totalSize).toBe(3);
    const page2 = await a2aRequest<any>(ep, 'GET', `/tasks?pageSize=2&pageToken=${page1.nextPageToken}`);
    expect(page2.tasks).toHaveLength(1);
    expect(page2.nextPageToken).toBe('');
  });

  it('A2ACancel on an outbound task cancels it on the peer, tells its session, and the requester sees CANCELED', async () => {
    const w = await world({ jasonScript: () => [], dylanScript: () => [] });
    w.dylan.node.setTrust('jason', 'collaborate');
    const r = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'q' });
    await w.hd.idle();
    const c = await w.jason.node.cancel(r.taskId);
    expect(c.task.state).toBe('TASK_STATE_CANCELED');
    expect(w.dylan.node.store.getTask(r.taskId)!.state).toBe('TASK_STATE_CANCELED');
    expect(w.hd.notes.some((n) => /cancelled task/.test(n))).toBe(true);
  });

  it('A2AReply refuses a pending (unapproved) task and a finished one', async () => {
    const w = await world({ jasonScript: () => [], dylanScript: () => [] });
    const r = await w.jason.node.request({ peer: 'dylan', kind: 'request', text: 'q' });
    expect(() => w.dylan.node.reply({ taskId: r.taskId, action: 'complete', text: 'x' })).toThrow(/waiting for your user to approve/);
    w.dylan.node.accept(r.taskId);
    w.dylan.node.reply({ taskId: r.taskId, action: 'complete', text: 'x' });
    expect(() => w.dylan.node.reply({ taskId: r.taskId, action: 'working', text: 'y' })).toThrow(/already COMPLETED/);
  });

  it('a push config pointing anywhere but the requester\'s own endpoint is refused', async () => {
    const jason = await makeNode({ name: 'Jason', certIndex: 0 });
    const dylan = await makeNode({ name: 'Dylan', certIndex: 1 });
    live.push(jason, dylan);
    await pair(jason, dylan);
    const { sendMessage } = await import('../../electron/a2a/client');
    const ep = { baseUrl: new URL(dylan.node.origin()).origin, certSha256: dylan.node.fingerprint(), token: jason.secrets.get('a2a.peer.dylan.tokenOut')! };
    const err = await sendMessage(ep, {
      message: { messageId: 'x1', role: 'ROLE_USER', parts: [{ text: 'q' }], metadata: { kind: 'request' } },
      configuration: { returnImmediately: true, taskPushNotificationConfig: { url: 'https://10.9.9.9:7427/a2a-push', token: 't' } },
    }).catch((e) => e);
    expect(err.status).toBe(400);
  });
});
