/**
 * Messaging a RUNNING subagent.
 *
 * A subagent runs synchronously inside the parent's turn, so anything typed
 * while it works went to the parent's interrupt queue and sat unread until
 * the child finished. If the child was heading the wrong way you could only
 * watch. This queue is drained by the subagent between its own rounds.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  markSubagentActive,
  markSubagentDone,
  activeSubagent,
  sendToSubagent,
  drainSubagentInbox,
  peekSubagentInbox,
  resetSubagentInbox,
} from '../electron/subagentInbox';

const S = 'session-1';
const INFO = { runId: 'abc12345', role: 'execute', description: 'do the thing' };

beforeEach(() => resetSubagentInbox());

describe('knowing whether a subagent is running', () => {
  it('reports none by default', () => {
    expect(activeSubagent(S)).toBeNull();
  });

  it('reports the running subagent between start and done', () => {
    markSubagentActive(S, INFO);
    expect(activeSubagent(S)).toEqual(INFO);
    markSubagentDone(S);
    expect(activeSubagent(S)).toBeNull();
  });

  it('is per session', () => {
    markSubagentActive(S, INFO);
    expect(activeSubagent('other')).toBeNull();
  });
});

describe('queueing messages for the subagent', () => {
  it('accepts messages while one is running', () => {
    markSubagentActive(S, INFO);
    expect(sendToSubagent(S, 'stop using grep')).toBe(1);
    expect(sendToSubagent(S, 'use ripgrep')).toBe(2);
    expect(peekSubagentInbox(S)).toBe(2);
  });

  it('REFUSES (-1) when no subagent is running, so the caller can fall back', () => {
    // Silently swallowing here would lose the user's text.
    expect(sendToSubagent(S, 'hello')).toBe(-1);
    expect(peekSubagentInbox(S)).toBe(0);
  });

  it('ignores empty / whitespace text', () => {
    markSubagentActive(S, INFO);
    expect(sendToSubagent(S, '   ')).toBe(0);
    expect(peekSubagentInbox(S)).toBe(0);
  });

  it('trims what it stores', () => {
    markSubagentActive(S, INFO);
    sendToSubagent(S, '  look at tests  ');
    expect(drainSubagentInbox(S)).toEqual(['look at tests']);
  });
});

describe('draining', () => {
  it('returns messages in FIFO order and clears', () => {
    markSubagentActive(S, INFO);
    sendToSubagent(S, 'first');
    sendToSubagent(S, 'second');
    expect(drainSubagentInbox(S)).toEqual(['first', 'second']);
    expect(drainSubagentInbox(S)).toEqual([]);
    expect(peekSubagentInbox(S)).toBe(0);
  });

  it('drains nothing when empty', () => {
    expect(drainSubagentInbox(S)).toEqual([]);
  });
});

describe('a message sent a moment too late is not lost', () => {
  it('markSubagentDone RETURNS anything still queued', () => {
    markSubagentActive(S, INFO);
    sendToSubagent(S, 'wait, also check the logs');
    // The subagent finishes before it drained that message.
    const leftovers = markSubagentDone(S);
    expect(leftovers).toEqual(['wait, also check the logs']);
    // ...and the queue is cleared so it can't be delivered twice.
    expect(peekSubagentInbox(S)).toBe(0);
  });

  it('returns an empty list when nothing was pending', () => {
    markSubagentActive(S, INFO);
    expect(markSubagentDone(S)).toEqual([]);
  });

  it('a second subagent starts with a clean inbox', () => {
    markSubagentActive(S, INFO);
    sendToSubagent(S, 'for the first one');
    markSubagentDone(S);
    markSubagentActive(S, { ...INFO, runId: 'def67890' });
    expect(peekSubagentInbox(S)).toBe(0);
  });
});
