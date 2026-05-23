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
