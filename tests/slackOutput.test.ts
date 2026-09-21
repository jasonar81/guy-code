/**
 * Slack output: thread parsing, readable transcripts, and multi-message
 * splitting. All three come from real complaints:
 *   - replying in a thread did nothing (the thread reader returns a DIFFERENT
 *     layout than the channel reader, so nothing parsed)
 *   - "latest output" was a truncated, unreadable mess
 *   - long replies were cut with "(truncated)" instead of being split
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

/** The REAL slack_read_thread payload, captured from a live call. */
const REAL_THREAD = JSON.stringify({
  messages:
    '=== THREAD PARENT MESSAGE ===\n' +
    'From: Jason Arnold <jarnold@ocient.com> (U3LLWAJJU)\n' +
    'Time: 2026-09-20 13:17:11 CDT\n' +
    'Message TS: 1789928231.874989\n' +
    'Guy, can you give me the latest output from the small tables 3 session?\n\n' +
    '=== THREAD REPLIES (1 total) ===\n\n' +
    '--- Reply 1 of 1 ---\n' +
    'From: Jason Arnold <jarnold@ocient.com> (U3LLWAJJU)\n' +
    'Time: 2026-09-20 13:17:14 CDT\n' +
    'Message TS: 1789928234.463409\n' +
    '_Small tables 3_ (waiting-on-user)\n' +
    '_guy:_ Clean cherry-pick\n' +
    '*Sent using* <@U0AMWHERK6J|Claude>\n',
  pagination_info: 'There are no more messages in this thread.\n',
});

describe('parseMessages: thread layout (was returning nothing)', () => {
  it('parses the parent AND the reply from a real thread payload', async () => {
    const { parseMessages } = await import('../electron/slackBridge');
    const msgs = parseMessages(REAL_THREAD);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].ts).toBe('1789928231.874989');
    expect(msgs[0].text).toContain('small tables 3');
    expect(msgs[1].ts).toBe('1789928234.463409');
  });

  it('still parses the channel layout (both must work)', async () => {
    const { parseMessages } = await import('../electron/slackBridge');
    const channel = JSON.stringify({
      messages:
        '=== Message from A <a@x.com> (U1) at t === \nMessage TS: 1.1\nGuy, help\n\n' +
        '=== Message from A <a@x.com> (U1) at t === \nMessage TS: 2.2\nGuy, status',
    });
    expect(parseMessages(channel)).toHaveLength(2);
  });
});

describe('isOurReply: telling our own posts apart in a self-DM', () => {
  it('recognises the "Sent using @app" footer Slack adds to our posts', async () => {
    const { isOurReply } = await import('../electron/slackBridge');
    expect(isOurReply('Some answer\n*Sent using* <@U0AMWHERK6J|Claude>')).toBe(true);
  });

  it('does not flag the user\'s own messages', async () => {
    const { isOurReply } = await import('../electron/slackBridge');
    expect(isOurReply('Guy, what sessions need me?')).toBe(false);
    expect(isOurReply('please continue')).toBe(false);
  });
});

describe('chunkForSlack: split instead of truncate', () => {
  it('leaves a short message alone', async () => {
    const { chunkForSlack } = await import('../electron/slackBridge');
    expect(chunkForSlack('hello')).toEqual(['hello']);
  });

  it('splits a long message into multiple parts and LOSES NOTHING', async () => {
    const { chunkForSlack } = await import('../electron/slackBridge');
    const para = 'x'.repeat(500);
    const text = Array.from({ length: 20 }, () => para).join('\n\n'); // ~10k chars
    const chunks = chunkForSlack(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk fits (allowing for the "(n/m)" label we append).
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1100);
    // All the content survives.
    const joined = chunks.join('').replace(/_\(\d+\/\d+\)_/g, '').replace(/\s/g, '');
    expect(joined.length).toBe(text.replace(/\s/g, '').length);
  });

  it('labels the parts so a multi-message answer is obvious', async () => {
    const { chunkForSlack } = await import('../electron/slackBridge');
    const chunks = chunkForSlack('a'.repeat(3000), 1000);
    expect(chunks[0]).toMatch(/_\(1\/\d+\)_/);
  });

  it('handles a single unbreakable line longer than the limit', async () => {
    const { chunkForSlack } = await import('../electron/slackBridge');
    const chunks = chunkForSlack('y'.repeat(2500), 1000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('returns nothing for empty input', async () => {
    const { chunkForSlack } = await import('../electron/slackBridge');
    expect(chunkForSlack('')).toEqual([]);
  });
});

describe('formatTranscript: readable output', () => {
  const asst = (text: string, tools = 0) => ({
    role: 'assistant',
    ts: Date.now(),
    content: [
      { type: 'text', text },
      ...Array.from({ length: tools }, () => ({ type: 'tool_use', name: 'PowerShell', input: {} })),
    ],
  });
  const toolOnly = () => ({
    role: 'assistant',
    ts: Date.now(),
    content: [{ type: 'tool_use', name: 'Write', input: {} }],
  });

  it('leads with the latest substantive reply IN FULL (not clipped at 400 chars)', async () => {
    const { formatTranscript } = await import('../electron/slackBridge');
    const long = 'The full answer. ' + 'detail '.repeat(200); // >1000 chars
    const out = formatTranscript('Marvin Fixes', 'waiting-on-user', [asst('older'), asst(long)], false);
    expect(out).toContain('Marvin Fixes');
    expect(out).toContain(long.trim());
  });

  it('summarises trailing tool calls instead of listing each one', async () => {
    const { formatTranscript } = await import('../electron/slackBridge');
    const out = formatTranscript('S', 'running', [asst('here is the plan'), toolOnly(), toolOnly()], false);
    expect(out).toContain('here is the plan');
    expect(out).toMatch(/2 more tool call/);
  });

  it('says it is still working when there is only tool activity', async () => {
    const { formatTranscript } = await import('../electron/slackBridge');
    const out = formatTranscript('S', 'running', [toolOnly(), toolOnly()], true);
    expect(out).toMatch(/Still working/i);
    expect(out).toMatch(/tool call/);
  });
});
