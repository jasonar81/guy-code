/**
 * Tests for the renderer store reducer (`src/lib/store.ts`), focused on
 * the TodoWrite → currentTodos plan-panel mapping. The user has
 * explicitly flagged stale plan panels as a bug, so we lock down the
 * three behaviors:
 *
 *   • A non-empty TodoWrite call replaces the visible plan wholesale.
 *   • An empty `todos: []` clears the plan (sets currentTodos to null).
 *   • A malformed/missing input leaves the plan unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the IPC bridge before importing the store. The store reaches
// for `window.api` lazily inside actions, but we stub it on the global
// just in case anything reads it eagerly.
beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.api = {
    agent: { onEvent: vi.fn(() => () => {}) },
    sessions: { list: vi.fn().mockResolvedValue([]) },
    apiKeys: { list: vi.fn().mockResolvedValue([]) },
  };
});

import { useApp } from '../src/lib/store';

const SESSION = 'test-session-id';

function reset() {
  // Zustand's setState replaces the entire state; reach in directly to
  // clear the chats map and any other per-session state for this id.
  useApp.setState((s) => ({
    chats: { ...s.chats, [SESSION]: undefined as any },
  }));
}

function fire(event: any) {
  useApp.getState().applyAgentEvent(event);
}

describe('store: TodoWrite → currentTodos', () => {
  beforeEach(() => {
    reset();
  });

  it('populates currentTodos on first TodoWrite', () => {
    fire({ type: 'turn_start', sessionId: SESSION });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't1',
      name: 'TodoWrite',
      input: {
        todos: [
          { id: 'a', content: 'Plan it', status: 'in_progress' },
          { id: 'b', content: 'Do it', status: 'pending' },
        ],
      },
    });
    const todos = useApp.getState().chats[SESSION]?.currentTodos;
    expect(todos).toEqual([
      { id: 'a', content: 'Plan it', status: 'in_progress' },
      { id: 'b', content: 'Do it', status: 'pending' },
    ]);
  });

  it('replaces the entire plan on a second TodoWrite', () => {
    fire({ type: 'turn_start', sessionId: SESSION });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't1',
      name: 'TodoWrite',
      input: {
        todos: [{ id: 'a', content: 'Old plan', status: 'in_progress' }],
      },
    });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't2',
      name: 'TodoWrite',
      input: {
        todos: [
          { id: 'x', content: 'New plan step 1', status: 'in_progress' },
          { id: 'y', content: 'New plan step 2', status: 'pending' },
          { id: 'z', content: 'New plan step 3', status: 'pending' },
        ],
      },
    });
    const todos = useApp.getState().chats[SESSION]?.currentTodos;
    expect(todos?.map((t) => t.id)).toEqual(['x', 'y', 'z']);
  });

  it('clears currentTodos on a TodoWrite with empty todos array', () => {
    fire({ type: 'turn_start', sessionId: SESSION });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't1',
      name: 'TodoWrite',
      input: { todos: [{ id: 'a', content: 'Plan', status: 'pending' }] },
    });
    expect(useApp.getState().chats[SESSION]?.currentTodos).toHaveLength(1);
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't2',
      name: 'TodoWrite',
      input: { todos: [] },
    });
    expect(useApp.getState().chats[SESSION]?.currentTodos).toBeNull();
  });

  it('leaves currentTodos unchanged on malformed input', () => {
    fire({ type: 'turn_start', sessionId: SESSION });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't1',
      name: 'TodoWrite',
      input: { todos: [{ id: 'a', content: 'Plan', status: 'pending' }] },
    });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't2',
      name: 'TodoWrite',
      // Missing `todos` array entirely → null from todosFromInput → unchanged.
      input: { something_else: 'bogus' },
    });
    expect(useApp.getState().chats[SESSION]?.currentTodos).toHaveLength(1);
  });

  it('drops invalid items but keeps valid ones in the same call', () => {
    fire({ type: 'turn_start', sessionId: SESSION });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't1',
      name: 'TodoWrite',
      input: {
        todos: [
          { id: 'good', content: 'Valid', status: 'pending' },
          { id: null, content: 'Invalid id', status: 'pending' }, // dropped
          { id: 'bad-status', content: 'X', status: 'oh-no' }, // dropped
          { id: 'good2', content: 'Also valid', status: 'completed' },
        ],
      },
    });
    const todos = useApp.getState().chats[SESSION]?.currentTodos;
    expect(todos?.map((t) => t.id)).toEqual(['good', 'good2']);
  });

  it('does NOT touch currentTodos for non-TodoWrite tool calls', () => {
    fire({ type: 'turn_start', sessionId: SESSION });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't1',
      name: 'TodoWrite',
      input: {
        todos: [{ id: 'a', content: 'Plan', status: 'in_progress' }],
      },
    });
    fire({
      type: 'tool_use_done',
      sessionId: SESSION,
      id: 't2',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(useApp.getState().chats[SESSION]?.currentTodos).toHaveLength(1);
  });
});

describe('store: sendMessage attachment handling (RTF/text-file regression)', () => {
  const SID = 'attach-session';
  beforeEach(() => {
    const runMock = vi.fn().mockResolvedValue({ started: true });
    (globalThis as any).window.api.agent = {
      ...(globalThis as any).window.api.agent,
      run: runMock,
    };
    (globalThis as any).__runMock = runMock;
    // Seed a session so sendMessage finds it.
    useApp.setState((s) => ({
      sessions: [
        ...s.sessions.filter((x) => x.id !== SID),
        { id: SID, project_id: 'p', cwd: '', jsonl_path: null } as any,
      ],
      chats: { ...s.chats, [SID]: undefined as any },
    }));
  });

  it('sends an RTF (rich-doc) attachment with NO typed text (does not silently abort)', async () => {
    await useApp.getState().sendMessage(SID, '', [
      {
        kind: 'rich-doc',
        name: 'big.rtf',
        docKind: 'rtf',
        dataBase64: 'AAAA',
        sizeBytes: 7_000_000,
      } as any,
    ]);
    // The bug: with no text + an unhandled kind, localBlocks was empty and
    // sendMessage returned BEFORE calling agent.run. Assert it DID call run.
    const runMock = (globalThis as any).__runMock;
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0][0].attachments[0].kind).toBe('rich-doc');
    // And a user bubble was added showing the attachment marker.
    const msgs = useApp.getState().chats[SID]?.messages ?? [];
    expect(msgs.length).toBe(1);
    const block = (msgs[0].content as any[])[0];
    expect(block.type).toBe('text');
    expect(block.text).toContain('big.rtf');
    expect(block.text).toContain('RTF');
  });

  it('sends a text-file attachment with no typed text', async () => {
    await useApp.getState().sendMessage(SID, '', [
      { kind: 'text-file', name: 'huge.log', text: 'x', sizeBytes: 2_000_000 } as any,
    ]);
    expect((globalThis as any).__runMock).toHaveBeenCalledTimes(1);
    const block = (useApp.getState().chats[SID]!.messages[0].content as any[])[0];
    expect(block.text).toContain('huge.log');
  });

  it('an unknown future kind still produces a block (no silent abort)', async () => {
    await useApp.getState().sendMessage(SID, '', [
      { kind: 'some-future-kind', name: 'mystery.xyz', sizeBytes: 1024 } as any,
    ]);
    expect((globalThis as any).__runMock).toHaveBeenCalledTimes(1);
    const block = (useApp.getState().chats[SID]!.messages[0].content as any[])[0];
    expect(block.text).toContain('mystery.xyz');
  });
});

describe('store: setForceContinue', () => {
  const SID = 'fc-session';
  beforeEach(() => {
    (globalThis as any).window.api.sessions = {
      ...(globalThis as any).window.api.sessions,
      setForceContinue: vi.fn().mockResolvedValue({
        ok: true,
        sessions: [{ id: SID, force_continue: 1 } as any],
      }),
    };
    useApp.setState((s) => ({
      sessions: [
        ...s.sessions.filter((x) => x.id !== SID),
        { id: SID, project_id: 'p', force_continue: 0 } as any,
      ],
    }));
  });

  it('optimistically flips the local flag and calls the IPC', async () => {
    await useApp.getState().setForceContinue(SID, true);
    expect((globalThis as any).window.api.sessions.setForceContinue).toHaveBeenCalledWith(SID, true);
    const sess = useApp.getState().sessions.find((x) => x.id === SID);
    expect(sess?.force_continue).toBe(1);
  });
});

describe('store: subagent live activity streams into the conversation', () => {
  const SID = 'subagent-stream-session';
  function reset2() {
    useApp.setState((s) => ({ chats: { ...s.chats, [SID]: undefined as any } }));
  }
  function fire2(e: any) { useApp.getState().applyAgentEvent(e); }
  beforeEach(reset2);

  it('builds a subagent block from start/text/tool/result/done events', () => {
    fire2({ type: 'turn_start', sessionId: SID, userText: 'do it' });
    fire2({ type: 'subagent_start', sessionId: SID, runId: 'r1', role: 'execute', description: 'make the change' });
    fire2({ type: 'subagent_text', sessionId: SID, runId: 'r1', text: 'Reading the file.' });
    fire2({ type: 'subagent_tool', sessionId: SID, runId: 'r1', toolId: 'tu1', name: 'Read', input: { file_path: '/x' } });
    fire2({ type: 'subagent_tool_result', sessionId: SID, runId: 'r1', toolId: 'tu1', content: 'file contents', isError: false });
    fire2({ type: 'subagent_done', sessionId: SID, runId: 'r1', ok: true });

    const msgs = useApp.getState().chats[SID]!.messages;
    const asst = msgs.find((m) => m.role === 'assistant')!;
    const sa = (asst.content as any[]).find((b) => b.type === 'subagent');
    expect(sa).toBeTruthy();
    expect(sa.role).toBe('execute');
    expect(sa.description).toBe('make the change');
    expect(sa.done).toBe(true);
    expect(sa.items).toEqual([
      { kind: 'text', text: 'Reading the file.' },
      { kind: 'tool', toolId: 'tu1', name: 'Read', input: { file_path: '/x' } },
      { kind: 'tool_result', toolId: 'tu1', content: 'file contents', isError: false },
    ]);
  });

  it('keeps two concurrent subagent runs separate by runId', () => {
    fire2({ type: 'turn_start', sessionId: SID, userText: 'x' });
    fire2({ type: 'subagent_start', sessionId: SID, runId: 'a', role: 'plan', description: 'plan it' });
    fire2({ type: 'subagent_start', sessionId: SID, runId: 'b', role: 'review', description: 'review it' });
    fire2({ type: 'subagent_text', sessionId: SID, runId: 'b', text: 'review note' });
    fire2({ type: 'subagent_text', sessionId: SID, runId: 'a', text: 'plan note' });

    const asst = useApp.getState().chats[SID]!.messages.find((m) => m.role === 'assistant')!;
    const blocks = (asst.content as any[]).filter((b) => b.type === 'subagent');
    expect(blocks.length).toBe(2);
    const a = blocks.find((b) => b.runId === 'a');
    const b = blocks.find((b) => b.runId === 'b');
    expect(a.items).toEqual([{ kind: 'text', text: 'plan note' }]);
    expect(b.items).toEqual([{ kind: 'text', text: 'review note' }]);
  });
});
