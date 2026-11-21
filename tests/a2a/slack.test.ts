// @vitest-environment node
/**
 * Slack bridge A2A commands (design 6.8): `Guy, a2a inbox`,
 * `Guy, accept a2a <id>`, `Guy, decline a2a <id> [reason]`, `Guy, a2a tasks`,
 * against a real A2A node pair. The Slack I/O and the rest of the app are
 * stubbed exactly as in tests/slackBridge.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { A2ANode } from '../../electron/a2a/node';

let current: A2ANode | null = null;
vi.mock('../../electron/a2a/index', () => ({ getA2ANode: () => current }));
vi.mock('../../electron/mcp', () => ({ invokeMcpTool: vi.fn(async () => ({ content: '{}', isError: false })), reconnectMcpServer: vi.fn() }));
vi.mock('../../electron/anthropic', () => ({ getClient: () => ({ messages: { create: vi.fn() } }) }));
vi.mock('../../electron/db', () => ({
  getSetting: () => null,
  setSetting: () => {},
  listSessionsAll: () => [],
  getSessionById: () => undefined,
  setSessionState: () => {},
  setSessionArchived: () => {},
  setSessionForceContinue: () => {},
  setSessionApiKey: () => {},
  upsertSession: () => {},
  upsertProject: () => {},
}));
vi.mock('../../electron/secret', () => ({ listApiKeys: () => [], getDefaultApiKeyId: () => null }));
vi.mock('../../electron/agent', () => ({ runUserTurn: vi.fn(), queueInterrupt: vi.fn(), cancelRun: vi.fn(), isRunning: () => false }));
vi.mock('../../electron/sessionRuntime', () => ({ loadMessagesWithTsFromJsonl: () => [], ourJsonlPath: (id: string) => `/tmp/${id}.jsonl` }));
vi.mock('../../electron/agentEvents', () => ({ broadcastStateChanged: () => {} }));

import { handleCommand } from '../../electron/slackBridge';
import { makeNode, pair, type TestNode } from './helpers';

const live: TestNode[] = [];
afterEach(async () => {
  while (live.length) await live.pop()!.node.stop();
  current = null;
});

describe('Slack: Guy, a2a ...', () => {
  it('inbox lists pending requests; accept delivers; decline rejects; tasks lists both', async () => {
    const jason = await makeNode({ name: 'Jason', certIndex: 0 });
    const dylan = await makeNode({ name: 'Dylan', certIndex: 1 });
    live.push(jason, dylan);
    await pair(jason, dylan);
    current = dylan.node;
    expect(await handleCommand('a2a inbox', false)).toBe('No A2A requests are waiting for you.');
    const a = await jason.node.request({ peer: 'dylan', kind: 'request', text: 'which branch has the H3 fix?' });
    const b = await jason.node.request({ peer: 'dylan', kind: 'notify', text: 'tell me when ja-sql1 is free' });

    const inbox = await handleCommand('a2a inbox', false);
    expect(inbox).toMatch(/2 A2A requests waiting for you/);
    expect(inbox).toContain(a.taskId.slice(0, 8));
    expect(inbox).toMatch(/which branch has the H3 fix/);

    expect(await handleCommand(`accept a2a ${a.taskId.slice(0, 8)}`, false)).toMatch(/^Accepted `/);
    expect(dylan.port.delivered()).toHaveLength(1);
    expect(dylan.node.store.getTask(a.taskId)!.state).toBe('TASK_STATE_WORKING');

    expect(await handleCommand(`decline a2a ${b.taskId.slice(0, 8)} busy all day`, false)).toMatch(/^Declined `/);
    expect(dylan.node.store.getTask(b.taskId)!.state).toBe('TASK_STATE_REJECTED');
    expect(dylan.node.store.getTask(b.taskId)!.last_status_json).toMatch(/busy all day/);

    expect(await handleCommand(`accept a2a ${b.taskId.slice(0, 8)}`, false)).toMatch(/Error: .*not waiting for approval/);
    const tasks = await handleCommand('a2a tasks', false);
    expect(tasks).toMatch(/from \*jason\* request - WORKING/);
    expect(tasks).toMatch(/from \*jason\* notify - REJECTED/);
    // the audit records who approved
    expect(dylan.node.audit.tail().some((e) => e.event === 'task.approval' && e.by === 'slack')).toBe(true);
  });

  it('says so plainly when A2A is off, and leaves other commands alone', async () => {
    current = null;
    expect(await handleCommand('a2a inbox', false)).toBe('A2A is turned off on this machine.');
    expect(await handleCommand('status', false)).toMatch(/0 sessions/);
  });
});
