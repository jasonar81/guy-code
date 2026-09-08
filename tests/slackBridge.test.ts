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
// The natural-language fallback calls a cheap model; `_llmReply` is what it
// "says". Tests that exercise the terse fast path never reach it.
let _llmReply = '{}';
const _createMock = vi.fn(async () => ({ content: [{ type: 'text', text: _llmReply }] }));
vi.mock('../electron/anthropic', () => ({
  getClient: () => ({ messages: { create: _createMock } }),
}));
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

  /**
   * The REAL shape the Slack MCP server returns: `messages` is a formatted
   * transcript STRING, not an array. Assuming an array meant no command was
   * ever seen - this payload is copied from a live call.
   */
  it('parses the real formatted-transcript payload', async () => {
    const { parseMessages } = await import('../electron/slackBridge');
    const real = JSON.stringify({
      messages:
        'Channel: DM (D3MC8RWSE)\n\n' +
        '=== Message from Jason Arnold <j@x.com> (U3LLWAJJU) at 2026-09-08 08:04:47 CDT === \n' +
        'Message TS: 1788872687.940679\n' +
        'Guy, just testing to see if you can see this.\n\n' +
        '=== Message from Jason Arnold <j@x.com> (U3LLWAJJU) at 2026-09-08 07:37:42 CDT === \n' +
        'Message TS: 1788871062.936449\n' +
        'Guy, help\n\n' +
        '=== Message from Jason Arnold <j@x.com> (U3LLWAJJU) at 2026-09-08 07:37:30 CDT === \n' +
        'Message TS: 1788871050.604319\n' +
        'Guy Code is connected. Send me commands starting with `Guy,`',
      pagination_info: 'more',
    });
    const msgs = parseMessages(real);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].ts).toBe('1788872687.940679');
    expect(msgs[0].text).toContain('just testing');
    expect(msgs[0].userId).toBe('U3LLWAJJU');
    expect(msgs[1].text).toBe('Guy, help');
  });

  it('does not treat our own reply as a command (no feedback loop)', async () => {
    const { parseMessages } = await import('../electron/slackBridge');
    const PREFIX = /^\s*guy\s*,\s*/i;
    const real = JSON.stringify({
      messages:
        '=== Message from Me <m@x.com> (U1) at t === \n' +
        'Message TS: 2.0\n' +
        'Guy Code is connected. Send me commands starting with `Guy,`',
    });
    const msgs = parseMessages(real);
    expect(msgs).toHaveLength(1);
    expect(PREFIX.test(msgs[0].text)).toBe(false);
  });

  it('keeps a multi-line message body intact', async () => {
    const { parseMessages } = await import('../electron/slackBridge');
    const real = JSON.stringify({
      messages:
        '=== Message from A <a@x.com> (U9) at t === \n' +
        'Message TS: 3.5\n' +
        'Guy, send Bench do this\nand then that',
    });
    const msgs = parseMessages(real);
    expect(msgs[0].text).toBe('Guy, send Bench do this\nand then that');
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

  it('falls back to help when even the interpreter cannot map it', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _llmReply = '{}'; // interpreter returns nothing usable
    const r = await handleCommand('do a barrel roll');
    expect(r).toMatch(/Not sure what you meant/i);
    expect(r).toMatch(/status/); // help is appended
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

  it('lists the API keys, marking the default', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    const r = await handleCommand('api keys');
    expect(r).toMatch(/Personal/);
    expect(r).toMatch(/default/);
  });
});

describe('parseInterpretation', () => {
  it('reads a command out of a JSON reply', async () => {
    const { parseInterpretation } = await import('../electron/slackBridge');
    expect(parseInterpretation('{"command":"needs you"}')).toEqual({ command: 'needs you' });
  });

  it('tolerates code fences and surrounding prose', async () => {
    const { parseInterpretation } = await import('../electron/slackBridge');
    const raw = 'Sure!\n```json\n{"command":"status"}\n```';
    expect(parseInterpretation(raw)).toEqual({ command: 'status' });
  });

  it('reads a conversational reply when there is no command', async () => {
    const { parseInterpretation } = await import('../electron/slackBridge');
    expect(parseInterpretation('{"reply":"I only manage sessions."}')).toEqual({
      reply: 'I only manage sessions.',
    });
  });

  it('returns null on junk', async () => {
    const { parseInterpretation } = await import('../electron/slackBridge');
    expect(parseInterpretation('no json here')).toBeNull();
    expect(parseInterpretation('')).toBeNull();
  });
});

describe('plain-English requests', () => {
  it('"which sessions need me?" runs the needs-you command', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _sessions.push(
      row({ id: '1', user_title: 'Blocked', state: 'waiting-on-user' }),
      row({ id: '2', user_title: 'Fine', state: 'idle' })
    );
    _llmReply = '{"command":"needs you"}';
    const r = await handleCommand(
      'please give me a list of the active sessions in needs you status?'
    );
    expect(r).toMatch(/Blocked/);
    expect(r).not.toMatch(/Fine/);
  });

  it('"what API keys do I have again?" lists the keys', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _llmReply = '{"command":"api keys"}';
    const r = await handleCommand('can you please tell me what API keys I have available again?');
    expect(r).toMatch(/Personal/);
  });

  it('passes a conversational reply straight through', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _llmReply = '{"reply":"I manage Guy Code sessions - ask me about those."}';
    const r = await handleCommand('what is the weather in Chicago');
    expect(r).toMatch(/I manage Guy Code sessions/);
  });

  it('does NOT call the interpreter for terse commands (fast path stays free)', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    _createMock.mockClear();
    _sessions.push(row({ id: '1', user_title: 'A', state: 'idle' }));
    await handleCommand('status');
    expect(_createMock).not.toHaveBeenCalled();
  });

  it('an interpreted command cannot recurse into the interpreter again', async () => {
    const { handleCommand } = await import('../electron/slackBridge');
    // The interpreter returns something that still won't match any command.
    _llmReply = '{"command":"still not a real command"}';
    _createMock.mockClear();
    const r = await handleCommand('do something vague');
    expect(r).toMatch(/Didn't understand/i);
    // Exactly one interpreter call - the re-entry runs with interpretation off.
    expect(_createMock).toHaveBeenCalledTimes(1);
  });
});
