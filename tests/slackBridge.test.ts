/**
 * Slack remote control: the pure logic (command parsing, session resolution,
 * message filtering). The Slack I/O itself goes through the existing Slack MCP
 * server and isn't exercised here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// The module imports a lot of main-process machinery; stub it all so we can
// unit-test the parsing/resolution helpers.
const _sessions: any[] = [];
vi.mock('../electron/mcp', () => ({ invokeMcpTool: vi.fn(async () => ({ content: '{}', isError: false })) }));
vi.mock('../electron/db', () => ({
  getSetting: () => null,
  setSetting: () => {},
  listSessionsAll: () => _sessions,
  getSessionById: (id: string) => _sessions.find((s) => s.id === id),
  setSessionState: () => {},
  setSessionArchived: () => {},
  setSessionForceContinue: () => {},
  setSessionApiKey: () => {},
  upsertSession: () => {},
  upsertProject: () => {},
}));
vi.mock('../electron/secret', () => ({
  listApiKeys: () => [{ id: 'k1', name: 'Personal' }],
  getDefaultApiKeyId: () => 'k1',
}));
vi.mock('../electron/agent', () => ({
  runUserTurn: vi.fn(async () => {}),
  queueInterrupt: vi.fn(),
  cancelRun: vi.fn(),
  isRunning: () => false,
}));
vi.mock('../electron/sessionRuntime', () => ({
  loadMessagesWithTsFromJsonl: () => [],
  ourJsonlPath: (id: string) => `/tmp/${id}.jsonl`,
}));
vi.mock('../electron/agentEvents', () => ({ broadcastStateChanged: () => {} }));
vi.mock('electron-log', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));

const row = (over: Partial<any>): any => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  project_id: 'p',
  jsonl_path: '/tmp/x.jsonl',
  state: 'idle',
  archived: 0,
  title: null,
  user_title: null,
  cwd: '',
  cost_all_time_micros: 0,
  cost_24h_micros: 0,
  ...over,
});

beforeEach(() => {
  _sessions.length = 0;
});

describe('parseMessages', () => {
  it('reads a messages array out of the MCP tool text', async () => {
    const { parseMessages } = await import('../electron/slackBridge');
    expect(parseMessages(JSON.stringify({ messages: [{ ts: '1', text: 'hi' }] }))).toHaveLength(1);
    expect(parseMessages(JSON.stringify([{ ts: '1' }]))).toHaveLength(1);
  });

  it('never throws on junk', async () => {
    const { parseMessages } = await import('../electron/slackBridge');
    expect(parseMessages('not json')).toEqual([]);
    expect(parseMessages('')).toEqual([]);
  });
});

describe('resolveSession', () => {
  it('matches on an id prefix', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const a = row({ id: 'abc12345-0000-0000-0000-000000000000', title: 'One' });
    const b = row({ id: 'def67890-0000-0000-0000-000000000000', title: 'Two' });
    const r = resolveSession([a, b], 'abc123');
    expect(r.session?.id).toBe(a.id);
  });

  it('matches on a name substring, case-insensitively', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const a = row({ id: '1', user_title: 'VLDB Promises' });
    const b = row({ id: '2', user_title: 'Fleet Management' });
    expect(resolveSession([a, b], 'fleet').session?.id).toBe('2');
    expect(resolveSession([a, b], 'vldb').session?.id).toBe('1');
  });

  it('reports ambiguity instead of guessing', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const a = row({ id: '1', user_title: 'Bench one' });
    const b = row({ id: '2', user_title: 'Bench two' });
    const r = resolveSession([a, b], 'bench');
    expect(r.session).toBeUndefined();
    expect(r.error).toMatch(/matches 2 sessions/i);
  });

  it('prefers non-archived when both match', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const live = row({ id: '1', user_title: 'Bench', archived: 0 });
    const old = row({ id: '2', user_title: 'Bench', archived: 1 });
    expect(resolveSession([live, old], 'bench').session?.id).toBe('1');
  });

  it('errors clearly when nothing matches', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    expect(resolveSession([row({})], 'nope').error).toMatch(/No session matches/i);
  });
});

describe('parseSince', () => {
  it('handles 30m / 2h / 1d', async () => {
    const { parseSince } = await import('../electron/slackBridge');
    const now = Date.now();
    expect(parseSince('since 30m')!).toBeLessThanOrEqual(now - 29 * 60_000);
    expect(parseSince('since 2h')!).toBeLessThanOrEqual(now - 119 * 60_000);
    expect(parseSince('since 1d')!).toBeLessThanOrEqual(now - 23 * 3_600_000);
  });

  it('treats a big bare number as an epoch', async () => {
    const { parseSince } = await import('../electron/slackBridge');
    expect(parseSince('since 1700000000000')).toBe(1700000000000);
  });

  it('returns null when absent', async () => {
    const { parseSince } = await import('../electron/slackBridge');
    expect(parseSince('output my session')).toBeNull();
  });
});

describe('handleCommand', () => {
  it('help lists the commands', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    const r = await handleCommand('help');
    expect(r).toMatch(/status/);
    expect(r).toMatch(/send <session>/);
  });

  it('status summarizes counts by state', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(
      row({ id: '1', user_title: 'A', state: 'waiting-on-user' }),
      row({ id: '2', user_title: 'B', state: 'running' }),
      row({ id: '3', user_title: 'C', state: 'idle' }),
      row({ id: '4', user_title: 'Old', state: 'idle', archived: 1 })
    );
    const r = await handleCommand('status');
    expect(r).toMatch(/3 sessions/); // archived excluded
    expect(r).toMatch(/1 need you/);
    expect(r).toMatch(/1 running/);
    expect(r).toMatch(/Needs you/);
  });

  it('needs you lists only those', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(
      row({ id: '1', user_title: 'Blocked', state: 'waiting-on-user' }),
      row({ id: '2', user_title: 'Fine', state: 'idle' })
    );
    const r = await handleCommand('needs you');
    expect(r).toMatch(/Blocked/);
    expect(r).not.toMatch(/Fine/);
  });

  it('unknown commands answer with help rather than failing silently', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    const r = await handleCommand('do a barrel roll');
    expect(r).toMatch(/Didn't understand/i);
  });

  it('send routes to a resolvable session', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(row({ id: 's1', user_title: 'Bench', state: 'idle' }));
    const r = await handleCommand('send Bench go run the thing');
    expect(r).toMatch(/Sent to/);
  });

  it('force continue parses on/off', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(row({ id: 's1', user_title: 'Bench' }));
    expect(await handleCommand('force continue Bench on')).toMatch(/ON/);
    expect(await handleCommand('force continue Bench off')).toMatch(/off/i);
  });

  it('archive reports what it archived', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(row({ id: 's1', user_title: 'Bench' }));
    expect(await handleCommand('archive Bench')).toMatch(/Archived/);
  });

  it('api key resolves a key by name', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(row({ id: 's1', user_title: 'Bench' }));
    expect(await handleCommand('api key Bench Personal')).toMatch(/Personal/);
  });

  it('api key reports the available keys when it cannot match', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(row({ id: 's1', user_title: 'Bench' }));
    expect(await handleCommand('api key Bench Nonexistent')).toMatch(/Have: Personal/);
  });
});
