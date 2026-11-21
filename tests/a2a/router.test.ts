// @vitest-environment node
/**
 * Router unit tests (electron/a2a/router.ts): the trust gate, the routing
 * order from design 5.4, how text gets into a session without breaking what
 * it is doing (design 6.3 step 5), and that the envelope is always applied.
 */
import { describe, expect, it } from 'vitest';
import { deliver, deliveryMode, gate, routeSession } from '../../electron/a2a/router';
import type { PeerRow } from '../../electron/a2a/store';
import { recordingPort, session } from './helpers';

const peer: PeerRow = {
  peer_id: 'dylan',
  display_name: 'Dylan Murphy',
  agent_kind: 'claude-code',
  card_url: 'https://10.0.0.2:7427/.well-known/agent-card.json',
  cert_sha256: 'a'.repeat(64),
  trust: 'inform',
  trust_prev: null,
  trust_expires_ts: null,
  trust_granted_ts: null,
  is_self: 0,
  token_out_ref: null,
  token_in_hash: null,
  card_json: null,
  last_seen_ts: null,
  created_ts: null,
};

describe('gate', () => {
  it('blocked is 403 for every kind', () => {
    for (const k of ['inform', 'request', 'notify'] as const) {
      expect(() => gate(k, 'blocked')).toThrow(expect.objectContaining({ httpStatus: 403 }));
    }
  });
  it('inform is delivered from inform, collaborate and full', () => {
    for (const t of ['inform', 'collaborate', 'full'] as const) expect(() => gate('inform', t)).not.toThrow();
  });
  it('request / notify from an inform peer wait for approval; from collaborate / full they are delivered', () => {
    for (const k of ['request', 'notify'] as const) {
      expect(gate(k, 'inform')).toBe('approve');
      expect(gate(k, 'collaborate')).toBe('deliver');
      expect(gate(k, 'full')).toBe('deliver');
    }
    expect(gate('inform', 'inform')).toBe('deliver');
  });
});

describe('routeSession: design 5.4 order', () => {
  const mk = () => {
    const ctx = session({ id: 'ctx', user_title: 'context owner', cwd: '/w/other' });
    const named = session({ id: 'named', user_title: 'perf harness', cwd: '/w/xgsrc' });
    const projOld = session({ id: 'proj-old', user_title: 'old', cwd: '/w/xgsrc', jsonl_mtime: 100 });
    const projNew = session({ id: 'proj-new', user_title: 'new', cwd: 'C:\\w\\xgsrc\\', jsonl_mtime: 200 });
    const archived = session({ id: 'arch', user_title: 'perf harness archived', archived: 1 });
    return recordingPort([ctx, named, projOld, projNew, archived]);
  };

  it('1. an existing contextId mapping wins over everything', () => {
    const r = routeSession(mk(), { mappedSessionId: 'ctx', routing: { toSession: 'perf harness', toProject: 'xgsrc' } });
    expect(r).toMatchObject({ via: 'context', session: { id: 'ctx' } });
  });
  it('2. then toSession (fuzzy name)', () => {
    const r = routeSession(mk(), { mappedSessionId: null, routing: { toSession: 'perf', toProject: 'xgsrc' } });
    expect(r).toMatchObject({ via: 'toSession', session: { id: 'named' } });
  });
  it('3. then toProject: most recently active session in that project (Windows paths too)', () => {
    const r = routeSession(mk(), { mappedSessionId: null, routing: { toProject: 'XGSRC' } });
    expect(r).toMatchObject({ via: 'toProject', session: { id: 'proj-new' } });
  });
  it('4. else the A2A inbox session, created on demand', () => {
    const port = mk();
    const r = routeSession(port, { mappedSessionId: null, routing: {} });
    expect(r).toMatchObject({ via: 'inbox', session: { id: 'inbox' } });
    expect(port.rows.some((s) => s.id === 'inbox')).toBe(true);
  });
  it('a stale mapping (session archived / deleted) and unknown hints fall through', () => {
    const r = routeSession(mk(), { mappedSessionId: 'arch', routing: { toSession: 'zzz', toProject: 'nope' } });
    expect(r.via).toBe('inbox');
  });
  it('an ambiguous toSession falls through rather than guessing', () => {
    const port = mk();
    port.rows.push(session({ id: 'n2', user_title: 'perf harness 2' }));
    const r = routeSession(port, { mappedSessionId: null, routing: { toSession: 'perf', toProject: 'xgsrc' } });
    expect(r.via).toBe('toProject');
  });
});

describe('deliveryMode', () => {
  it('running -> interrupt, regardless of stored state', () => {
    expect(deliveryMode(session({ state: 'idle' }), true)).toBe('interrupt');
  });
  it('sleeping / parked -> queued (the wait is not broken)', () => {
    for (const st of ['sleeping-tool', 'sleeping-budget', 'waiting-on-system']) {
      expect(deliveryMode(session({ state: st }), false)).toBe('queued');
    }
  });
  it('idle, waiting-on-user, error -> start a turn', () => {
    for (const st of ['idle', 'waiting-on-user', 'error']) expect(deliveryMode(session({ state: st }), false)).toBe('turn');
  });
  it('a tool sleep is woken only when it is a WaitForA2A on this message, or the message is urgent', () => {
    expect(deliveryMode(session({ state: 'sleeping-tool' }), false, { waitingForThis: true })).toBe('wake');
    expect(deliveryMode(session({ state: 'sleeping-tool' }), false, { urgent: true })).toBe('wake');
    // never breaks a budget park or a waiting-on-system
    expect(deliveryMode(session({ state: 'sleeping-budget' }), false, { waitingForThis: true, urgent: true })).toBe('queued');
  });
  it('urgent is honoured only from trust >= collaborate', () => {
    const s = session({ id: 'z', state: 'sleeping-tool' });
    const port = recordingPort([s]);
    const base2 = { peer, kind: 'inform' as const, contextId: 'c', taskId: 't', routing: { toSession: 'z' }, mappedSessionId: null, urgent: true, text: 'x' };
    deliver(port, { ...base2, trust: 'inform' });
    expect(port.turns).toHaveLength(0);
    expect(port.interrupts).toHaveLength(1);
    deliver(port, { ...base2, trust: 'collaborate' });
    expect(port.turns).toHaveLength(1);
  });
});

describe('deliver', () => {
  const base = { peer, trust: 'inform' as const, kind: 'inform' as const, contextId: 'ctx-1', taskId: 'task-1', routing: {}, mappedSessionId: null };

  it('always hands the session the envelope, never the raw text', () => {
    const port = recordingPort([session({ id: 'a', user_title: 'alpha' })]);
    const r = deliver(port, { ...base, text: 'raw words', routing: { toSession: 'alpha', fromSessionLabel: 'sql-gap PR18', fromProject: 'xgsrc' } });
    expect(port.turns).toEqual([{ sessionId: 'a', text: r.envelope }]);
    expect(r.envelope).toMatch(/^\[A2A message from dylan \(Dylan Murphy, Claude Code\) · trust: inform · task task-1 · context ctx-1 · from "sql-gap PR18" \(xgsrc\)\]/);
    expect(r.envelope).not.toBe('raw words');
  });

  it('deliver() refuses a message that needs approval, and touches no session', () => {
    const port = recordingPort([session({ id: 'a' })]);
    expect(() => deliver(port, { ...base, kind: 'request', text: 'x' })).toThrow();
    expect(port.delivered()).toHaveLength(0);
    expect(port.rows.some((s) => s.id === 'inbox')).toBe(false);
  });
});
