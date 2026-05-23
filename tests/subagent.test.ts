/**
 * Tests for `electron/subagent.ts`.
 *
 * The subagent loop is the second-most-failure-prone module after the
 * budget governor — it touches Anthropic streaming, tool dispatch,
 * cost recording, and cancellation propagation. We pin down:
 *
 *   • Tool subset enforcement per role (no Task/Plan/Execute/Review
 *     leaks into the child; no TodoWrite; no WaitForUser).
 *   • A model that returns end_turn immediately yields the assistant
 *     text as the final result.
 *   • A model that returns tool_use blocks dispatches them and feeds
 *     results back; the loop terminates when tool_use stops appearing.
 *   • If the model invokes a disallowed tool name (e.g. Task), the
 *     subagent returns a tool_result error and the model retries.
 *   • Parent's AbortSignal aborts the child (between rounds + during
 *     tool dispatch).
 *   • Budget pre-flight blocks the child when the bucket is exhausted.
 *   • Cost rows are inserted into usage_events with a
 *     `subagent-<runId>-` prefixed turnId for audit traceability.
 *
 * Strategy: vi.mock the Anthropic SDK so we control exactly what the
 * model "returns" each round; mock the db, budget, and tool registry
 * so we can assert on inputs to those modules without spinning up
 * SQLite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- Mocks ---------------------------------------------------------

// Mock Anthropic so we can script its streaming responses per round.
// Each call to client.messages.stream() consumes the next entry from
// `_responses`. The stream is iterable and exposes `.finalMessage()`,
// matching the SDK's surface used by subagent.ts.
let _responses: Array<{
  content: any[];
  usage?: any;
  model?: string;
  id?: string;
}> = [];
let _streamCallCount = 0;
let _lastStreamArgs: any = null;

function buildStream(resp: { content: any[]; usage?: any; model?: string; id?: string }) {
  return {
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { done: true, value: undefined };
          done = true;
          // We don't need to emit individual SSE events for these tests.
          return { done: true, value: undefined };
        },
      };
    },
    async finalMessage() {
      return {
        id: resp.id ?? `msg_${_streamCallCount}`,
        model: resp.model ?? 'claude-opus-4-7',
        content: resp.content,
        usage: resp.usage ?? {
          input_tokens: 100,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 50,
        },
        stop_reason: resp.content.some((b) => b.type === 'tool_use')
          ? 'tool_use'
          : 'end_turn',
      };
    },
  };
}

vi.mock('../electron/anthropic', () => ({
  DEFAULT_MODEL: 'claude-opus-4-7[1m]',
  parseExtendedContext: (model: string) => ({
    id: model.replace(/\[1m\]$/, ''),
    want1m: model.includes('[1m]'),
  }),
  getClient: () => ({
    messages: {
      stream(args: any) {
        _streamCallCount++;
        // Deep-snapshot messages so later mutations by the loop don't
        // change what the test sees as "what was passed to round N".
        _lastStreamArgs = {
          ...args,
          messages: JSON.parse(JSON.stringify(args.messages)),
        };
        const resp = _responses.shift();
        if (!resp) {
          throw new Error(
            `test bug: subagent called Anthropic ${_streamCallCount} times but only ${_streamCallCount - 1} responses scripted`
          );
        }
        return buildStream(resp);
      },
    },
  }),
}));

// Mock TOOLS registry: provide minimal stubs for the tools the role
// subsets reference. Each stub records its calls so we can assert on
// dispatch order and inputs.
const _toolCalls: Array<{ name: string; input: any }> = [];
const _toolReturns = new Map<string, string>();
function makeStub(name: string) {
  return {
    schema: { name, description: `stub ${name}`, input_schema: { type: 'object', properties: {} } },
    async execute(input: any) {
      _toolCalls.push({ name, input });
      return _toolReturns.get(name) ?? `stub-result for ${name}`;
    },
  };
}

vi.mock('../electron/tools', () => {
  const TOOLS: Record<string, any> = {
    Read: makeStub('Read'),
    Write: makeStub('Write'),
    Edit: makeStub('Edit'),
    Glob: makeStub('Glob'),
    Grep: makeStub('Grep'),
    Bash: makeStub('Bash'),
    TodoWrite: makeStub('TodoWrite'),
    WaitForUser: makeStub('WaitForUser'),
    WaitForFile: makeStub('WaitForFile'),
    WaitForProcess: makeStub('WaitForProcess'),
    WaitForTime: makeStub('WaitForTime'),
    WaitForHttp: makeStub('WaitForHttp'),
    recall_memory: makeStub('recall_memory'),
    list_memory: makeStub('list_memory'),
    list_skills: makeStub('list_skills'),
    read_skill: makeStub('read_skill'),
    search_conversation: makeStub('search_conversation'),
    save_memory: makeStub('save_memory'),
    Task: makeStub('Task'),
    Plan: makeStub('Plan'),
    Execute: makeStub('Execute'),
    Review: makeStub('Review'),
  };
  return {
    TOOLS,
    async executeTool(name: string, input: any) {
      const t = TOOLS[name];
      if (!t) return { content: `unknown tool ${name}`, isError: true };
      const r = await t.execute(input);
      return { content: r, isError: false };
    },
  };
});

vi.mock('../electron/mcp', () => ({
  getMcpToolSchemas: () => [],
}));

// Mock the db so we can spy on usage event inserts without SQLite.
const _usageInserts: any[] = [];
vi.mock('../electron/db', () => ({
  insertUsageEvent: (u: any) => {
    _usageInserts.push(u);
  },
}));

// Mock budget so we can flip pre-flight allow/block per test.
let _budgetAllow = true;
let _budgetReason = '';
// The subagent loop now imports `precheckCall`; keep `precheckTurn` as
// a back-compat alias in the mock for the (slim) chance an old test
// fixture references it.
vi.mock('../electron/budget', () => {
  const fn = () => ({
    allowed: _budgetAllow,
    reason: _budgetReason,
    capMicros: 1_000_000,
    spentMicros: 0,
    nextRetryTs: 0,
  });
  return { precheckCall: fn, precheckTurn: fn };
});

// Stub electron-log via the global setup, plus pricing returning a
// fixed value so the cost-row math is deterministic.
vi.mock('../electron/pricing', () => ({
  computeCostMicros: () => 1234,
}));

// Imports must come AFTER vi.mock — vitest hoists the mocks.
import { runSubagent, toolsForRole } from '../electron/subagent';

// ---------- Test setup ---------------------------------------------------

const PARENT = {
  sessionId: 'parent-session',
  projectId: 'proj-1',
  cwd: '/tmp/proj',
  apiKeyId: 'k-test' as string | null,
};

beforeEach(() => {
  _responses = [];
  _streamCallCount = 0;
  _lastStreamArgs = null;
  _toolCalls.length = 0;
  _toolReturns.clear();
  _usageInserts.length = 0;
  _budgetAllow = true;
  _budgetReason = '';
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------- Tool subset enforcement -------------------------------------

describe('toolsForRole', () => {
  it('plan role excludes write/edit/Task tools', () => {
    const tools = toolsForRole('plan');
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).toContain('recall_memory');
    expect(tools).toContain('search_conversation');
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('Plan');
    expect(tools).not.toContain('Execute');
    expect(tools).not.toContain('Review');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('TodoWrite');
    expect(tools).not.toContain('WaitForUser');
  });

  it('execute role includes edit tools but excludes Task/recursion', () => {
    const tools = toolsForRole('execute');
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
    expect(tools).toContain('Edit');
    expect(tools).toContain('save_memory');
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('Plan');
    expect(tools).not.toContain('Execute');
    expect(tools).not.toContain('Review');
    expect(tools).not.toContain('TodoWrite');
    expect(tools).not.toContain('WaitForUser');
  });

  it('review role is read-only', () => {
    const tools = toolsForRole('review');
    expect(tools).toContain('Read');
    expect(tools).toContain('Glob');
    expect(tools).toContain('Grep');
    expect(tools).not.toContain('Write');
    expect(tools).not.toContain('Edit');
    expect(tools).not.toContain('save_memory');
    expect(tools).not.toContain('Task');
  });

  it('general role mirrors execute', () => {
    expect(toolsForRole('general').sort()).toEqual(toolsForRole('execute').sort());
  });
});

// ---------- Streaming + dispatch ----------------------------------------

describe('runSubagent', () => {
  it('returns final text on a single end_turn round', async () => {
    _responses.push({
      content: [{ type: 'text', text: 'all done' }],
    });
    const out = await runSubagent(PARENT, {
      role: 'general',
      description: 'quick test',
      prompt: 'do nothing',
    });
    expect(out).toBe('all done');
    expect(_streamCallCount).toBe(1);
    expect(_toolCalls).toHaveLength(0);
  });

  it('dispatches tool_use blocks then continues to end_turn', async () => {
    _responses.push({
      content: [
        { type: 'text', text: 'I will read a file' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file: 'foo.txt' } },
      ],
    });
    _toolReturns.set('Read', 'file contents here');
    _responses.push({
      content: [{ type: 'text', text: 'finished' }],
    });
    const out = await runSubagent(PARENT, {
      role: 'general',
      description: 't',
      prompt: 'p',
    });
    expect(out).toBe('finished');
    expect(_streamCallCount).toBe(2);
    expect(_toolCalls).toEqual([{ name: 'Read', input: { file: 'foo.txt' } }]);
  });

  it('refuses disallowed tool names with a structured error_result', async () => {
    // First round: model tries to spawn a nested Task subagent (forbidden).
    _responses.push({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'Task', input: { description: 'recurse', prompt: 'oh no' } },
      ],
    });
    // Second round: model recovers and returns final text.
    _responses.push({
      content: [{ type: 'text', text: 'ok no recursion then' }],
    });
    const out = await runSubagent(PARENT, {
      role: 'general',
      description: 't',
      prompt: 'p',
    });
    expect(out).toBe('ok no recursion then');
    // The Task tool was NOT actually executed (disallowed).
    expect(_toolCalls.find((c) => c.name === 'Task')).toBeUndefined();
    // The second-round messages should contain the refusal as a tool_result.
    const msgs = _lastStreamArgs.messages;
    const lastUser = msgs[msgs.length - 1];
    expect(lastUser.role).toBe('user');
    expect(lastUser.content[0].type).toBe('tool_result');
    expect(lastUser.content[0].is_error).toBe(true);
    expect(lastUser.content[0].content).toMatch(/not available to subagents/);
  });

  it('records a usage_events row per round with a subagent-prefixed turnId', async () => {
    _responses.push({
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
      ],
    });
    _responses.push({
      content: [{ type: 'text', text: 'done' }],
    });
    await runSubagent(PARENT, { role: 'plan', description: 't', prompt: 'p' });
    expect(_usageInserts).toHaveLength(2);
    for (const r of _usageInserts) {
      expect(r.sessionId).toBe(PARENT.sessionId);
      expect(r.projectId).toBe(PARENT.projectId);
      expect(r.apiKeyId).toBe(PARENT.apiKeyId);
      expect(r.source).toBe('live');
      expect(r.turnId).toMatch(/^subagent-[0-9a-f]{8}-msg_\d+$/);
      expect(r.costUsdMicros).toBe(1234);
    }
  });

  it('throws when the parent signal aborts before the first round', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runSubagent(
        { ...PARENT, signal: ctrl.signal },
        { role: 'general', description: 't', prompt: 'p' }
      )
    ).rejects.toThrow(/aborted/);
    expect(_streamCallCount).toBe(0);
  });

  it('throws when budget pre-flight blocks the first round', async () => {
    _budgetAllow = false;
    _budgetReason = 'hour spend exhausted';
    await expect(
      runSubagent(PARENT, { role: 'general', description: 't', prompt: 'p' })
    ).rejects.toThrow(/budget/i);
    expect(_streamCallCount).toBe(0);
  });

  it('caps run length at MAX_SUBAGENT_ROUNDS and returns a partial-work message', async () => {
    // Script 31 rounds where every response says "call a tool", forcing
    // the loop to never reach end_turn.
    for (let i = 0; i < 31; i++) {
      _responses.push({
        content: [
          { type: 'tool_use', id: `tu_${i}`, name: 'Read', input: {} },
        ],
      });
    }
    const out = await runSubagent(PARENT, {
      role: 'general',
      description: 't',
      prompt: 'p',
    });
    expect(out).toMatch(/30-round cap/);
  });

  it('only exposes the role-curated toolset to the model', async () => {
    _responses.push({
      content: [{ type: 'text', text: 'done' }],
    });
    await runSubagent(PARENT, { role: 'review', description: 't', prompt: 'p' });
    const sent = (_lastStreamArgs.tools as any[]).map((t) => t.name);
    expect(sent).toContain('Read');
    expect(sent).toContain('Grep');
    expect(sent).toContain('Glob');
    expect(sent).not.toContain('Write');
    expect(sent).not.toContain('Edit');
    expect(sent).not.toContain('Task');
    expect(sent).not.toContain('Plan');
    expect(sent).not.toContain('Execute');
    expect(sent).not.toContain('Review');
    expect(sent).not.toContain('TodoWrite');
    expect(sent).not.toContain('WaitForUser');
  });

  it('passes the role-specific system prompt to the model', async () => {
    _responses.push({ content: [{ type: 'text', text: 'done' }] });
    await runSubagent(PARENT, { role: 'plan', description: 't', prompt: 'p' });
    expect(_lastStreamArgs.system).toMatch(/Role: PLANNER/);
    expect(_lastStreamArgs.system).toMatch(/CANNOT spawn further subagents/);
  });

  it('passes server-side context_management config (clear_tool_uses_20250919)', async () => {
    _responses.push({ content: [{ type: 'text', text: 'done' }] });
    await runSubagent(PARENT, {
      role: 'general',
      description: 't',
      prompt: 'p',
    });
    expect(_lastStreamArgs.context_management.edits[0].type).toBe(
      'clear_tool_uses_20250919'
    );
    expect(_lastStreamArgs.context_management.edits[0].exclude_tools).toContain(
      'recall_memory'
    );
  });
});
