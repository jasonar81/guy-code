/**
 * Thread continuity: after we answer a command in a thread, anything the user
 * says in that thread is meant for us - no "Guy, " prefix needed - and the
 * thread so far is passed as context.
 *
 * The traps this guards:
 *   - In a self-DM our OWN replies come back authored by the user, so we must
 *     identify them by the ts we recorded, not by author.
 *   - Threads can't be tracked forever: idle >24h must be dropped.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// A tiny in-memory settings store so load/saveThreads round-trip for real.
const _settings = new Map<string, string>();
vi.mock('../electron/db', () => ({
  getSetting: (k: string) => _settings.get(k) ?? null,
  setSetting: (k: string, v: string) => { _settings.set(k, v); },
  listSessionsAll: () => [],
  getSessionById: () => undefined,
  setSessionState: () => {}, setSessionArchived: () => {},
  setSessionForceContinue: () => {}, setSessionApiKey: () => {},
  upsertSession: () => {}, upsertProject: () => {},
}));
vi.mock('../electron/mcp', () => ({ invokeMcpTool: vi.fn(), reconnectMcpServer: vi.fn() }));
vi.mock('../electron/anthropic', () => ({ getClient: () => ({ messages: { create: vi.fn() } }) }));
vi.mock('../electron/secret', () => ({ listApiKeys: () => [], getDefaultApiKeyId: () => null }));
vi.mock('../electron/agent', () => ({
  runUserTurn: vi.fn(), queueInterrupt: vi.fn(), cancelRun: vi.fn(), isRunning: () => false,
}));
vi.mock('../electron/sessionRuntime', () => ({
  loadMessagesWithTsFromJsonl: () => [], ourJsonlPath: (i: string) => `/tmp/${i}.jsonl`,
}));
vi.mock('../electron/agentEvents', () => ({ broadcastStateChanged: () => {} }));
vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {} } }));

beforeEach(() => _settings.clear());

describe('thread tracking', () => {
  it('remembers a thread and records our own reply ts', async () => {
    const { rememberThread, loadThreads } = await import('../electron/slackBridge');
    rememberThread('1000.1', '1000.2');
    const t = loadThreads();
    expect(Object.keys(t)).toEqual(['1000.1']);
    expect(t['1000.1'].ours).toContain('1000.2');
    expect(t['1000.1'].cursor).toBe('1000.1');
  });

  it('accumulates several of our replies in the same thread', async () => {
    const { rememberThread, loadThreads } = await import('../electron/slackBridge');
    rememberThread('1000.1', '1000.2');
    rememberThread('1000.1', '1000.9');
    expect(loadThreads()['1000.1'].ours).toEqual(['1000.2', '1000.9']);
  });

  it('drops a thread with no activity for 24h', async () => {
    const { saveThreads, loadThreads } = await import('../electron/slackBridge');
    const now = Date.now();
    saveThreads(
      {
        fresh: { cursor: 'a', touched: now - 60_000, ours: [] },
        stale: { cursor: 'b', touched: now - 25 * 60 * 60 * 1000, ours: [] },
      },
      now
    );
    const t = loadThreads();
    expect(Object.keys(t)).toEqual(['fresh']);
  });

  it('keeps a thread that is 23h old (just inside the window)', async () => {
    const { saveThreads, loadThreads } = await import('../electron/slackBridge');
    const now = Date.now();
    saveThreads({ ok: { cursor: 'a', touched: now - 23 * 60 * 60 * 1000, ours: [] } }, now);
    expect(Object.keys(loadThreads())).toEqual(['ok']);
  });

  it('caps how many threads it tracks (newest kept)', async () => {
    const { saveThreads, loadThreads } = await import('../electron/slackBridge');
    const now = Date.now();
    const many: Record<string, any> = {};
    for (let i = 0; i < 80; i++) {
      many['t' + i] = { cursor: 'c', touched: now - i * 1000, ours: [] };
    }
    saveThreads(many, now);
    const keys = Object.keys(loadThreads());
    expect(keys.length).toBeLessThanOrEqual(50);
    expect(keys).toContain('t0'); // newest survives
    expect(keys).not.toContain('t79'); // oldest evicted
  });

  it('survives a corrupt settings value', async () => {
    const { loadThreads } = await import('../electron/slackBridge');
    _settings.set('slack_bridge.threads', 'not json');
    expect(loadThreads()).toEqual({});
  });
});

describe('stripPrefix', () => {
  it('removes an optional leading "Guy," so a thread reply needs no prefix', async () => {
    const { stripPrefix } = await import('../electron/slackBridge');
    expect(stripPrefix('Guy, status')).toBe('status');
    expect(stripPrefix('guy,   status')).toBe('status');
  });

  it('leaves a bare sentence untouched (the normal thread case)', async () => {
    const { stripPrefix } = await import('../electron/slackBridge');
    expect(stripPrefix('what about the other one?')).toBe('what about the other one?');
  });
});
