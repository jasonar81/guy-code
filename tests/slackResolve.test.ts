/**
 * Session-reference resolution, driven by the real failures Jason hit from his
 * phone:
 *   "Guy, tell the flood session to please continue"  -> resolved the session
 *       named "the" and matched 46 sessions.
 *   "Guy, ... the Marvin fixes session ..."           -> stayed permanently
 *       ambiguous against "BALD/MARVIN Testing", even when he supplied the id.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../electron/mcp', () => ({ invokeMcpTool: vi.fn(), reconnectMcpServer: vi.fn() }));
vi.mock('../electron/anthropic', () => ({ getClient: () => ({ messages: { create: vi.fn() } }) }));
vi.mock('../electron/db', () => ({
  getSetting: () => null, setSetting: () => {}, listSessionsAll: () => [],
  getSessionById: () => undefined, setSessionState: () => {}, setSessionArchived: () => {},
  setSessionForceContinue: () => {}, setSessionApiKey: () => {}, upsertSession: () => {},
  upsertProject: () => {},
}));
vi.mock('../electron/secret', () => ({ listApiKeys: () => [], getDefaultApiKeyId: () => null }));
vi.mock('../electron/agent', () => ({
  runUserTurn: vi.fn(), queueInterrupt: vi.fn(), cancelRun: vi.fn(), isRunning: () => false,
}));
vi.mock('../electron/sessionRuntime', () => ({
  loadMessagesWithTsFromJsonl: () => [], ourJsonlPath: (i: string) => `/tmp/${i}.jsonl`,
}));
vi.mock('../electron/agentEvents', () => ({ broadcastStateChanged: () => {} }));
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));

const row = (over: Partial<any>): any => ({
  id: 'aaaaaaaa-0000-0000-0000-000000000000',
  project_id: 'p', jsonl_path: '/tmp/x.jsonl', state: 'idle', archived: 0,
  title: null, user_title: null, cwd: '', cost_all_time_micros: 0, cost_24h_micros: 0,
  ...over,
});

/** Jason's real session list, near enough. */
const realWorld = () => [
  row({ id: '121e64be-0000-0000-0000-000000000000', user_title: 'Flood', state: 'waiting-on-user' }),
  row({ id: '46d905f1-0000-0000-0000-000000000000', user_title: 'Small tables 2', state: 'waiting-on-user' }),
  row({ id: '4cf5acb3-0000-0000-0000-000000000000', user_title: 'Marvin Fixes', state: 'waiting-on-user' }),
  row({ id: 'b9fba03e-0000-0000-0000-000000000000', user_title: 'BALD/MARVIN Testing', state: 'idle' }),
  row({ id: '4d47d6ca-0000-0000-0000-000000000000', user_title: 'Weather' }),
  row({ id: '1af2dfc8-0000-0000-0000-000000000000', user_title: 'Others projects' }),
  row({ id: 'c8863d49-0000-0000-0000-000000000000', user_title: 'Complexity Theory' }),
  row({ id: 'd2489b62-0000-0000-0000-000000000000', user_title: 'What is the temperature in Chicago right now?' }),
  row({ id: '2c38928d-0000-0000-0000-000000000000', user_title: 'Can you find the confluence page I wrote about in database research?' }),
];

describe('resolveSession: the filler-word bug', () => {
  it('"the flood session" resolves Flood (was: matched 46 sessions)', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const r = resolveSession(realWorld(), 'the flood session');
    expect(r.error).toBeUndefined();
    expect(r.session?.user_title).toBe('Flood');
  });

  it('a bare "the" no longer sweeps in every session with "the" in it', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const r = resolveSession(realWorld(), 'the');
    // After stripping the article there is nothing left to match on.
    expect(r.session).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it('strips "session <id>" phrasing', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    expect(resolveSession(realWorld(), 'session 4cf5acb3').session?.user_title).toBe('Marvin Fixes');
  });

  it('strips surrounding quotes', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    expect(resolveSession(realWorld(), '\u201cMarvin fixes\u201d').session?.user_title).toBe('Marvin Fixes');
  });
});

describe('resolveSession: ranking beats false ambiguity', () => {
  it('"Marvin fixes" picks Marvin Fixes over BALD/MARVIN Testing', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const r = resolveSession(realWorld(), 'Marvin fixes');
    expect(r.error).toBeUndefined();
    expect(r.session?.user_title).toBe('Marvin Fixes');
  });

  it('an exact name wins outright', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    expect(resolveSession(realWorld(), 'Flood').session?.user_title).toBe('Flood');
  });

  it('a full id prefix resolves directly', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    expect(resolveSession(realWorld(), '4cf5acb3').session?.user_title).toBe('Marvin Fixes');
  });

  it('still reports ambiguity when two candidates really are equal', async () => {
    const { resolveSession } = await import('../electron/slackBridge');
    const rows = [
      row({ id: '1', user_title: 'Bench run' }),
      row({ id: '2', user_title: 'Bench run' }),
    ];
    expect(resolveSession(rows, 'bench run').error).toMatch(/matches 2 sessions/i);
  });
});

describe('matchSendCommand: multi-word session names', () => {
  it('"send small tables 2 please continue" splits correctly', async () => {
    const { matchSendCommand } = await import('../electron/slackBridge');
    const m = matchSendCommand('send small tables 2 please continue', realWorld());
    expect(m).not.toBeNull();
    expect(m![1]).toBe('small tables 2');
    expect(m![2]).toBe('please continue');
  });

  it('"tell the flood session please continue" finds Flood', async () => {
    const { matchSendCommand, resolveSession } = await import('../electron/slackBridge');
    const m = matchSendCommand('tell the flood session please continue', realWorld());
    expect(m).not.toBeNull();
    expect(resolveSession(realWorld(), m![1]).session?.user_title).toBe('Flood');
  });

  it('a single-word name still works', async () => {
    const { matchSendCommand } = await import('../electron/slackBridge');
    const m = matchSendCommand('send Flood go ahead', realWorld());
    expect(m![1]).toBe('Flood');
    expect(m![2]).toBe('go ahead');
  });

  it('returns null when there is no text to send', async () => {
    const { matchSendCommand } = await import('../electron/slackBridge');
    expect(matchSendCommand('send Flood', realWorld())).toBeNull();
  });
});
