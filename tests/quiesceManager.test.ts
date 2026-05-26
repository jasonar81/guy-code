/**
 * Tests for `electron/quiesceManager.ts` — the drain-before-quit gate
 * the auto-update install IPC uses to avoid killing in-flight agent
 * turns mid-stream.
 *
 * Strategy: vi.mock the `./db` module so we can control which session
 * states are reported. No SQLite needed. Each test reshapes the fake
 * "rows-by-state" map and asserts on the manager's behavior.
 *
 * Coverage:
 *   • listActiveSessionIds returns only running + waiting-on-system.
 *   • drainBeforeQuit resolves immediately when no active sessions.
 *   • drainBeforeQuit rejects on timeout with a message naming the
 *     stuck sessions (the renderer pattern-matches this string to
 *     decide whether to surface the Force Install button).
 *   • drainBeforeQuit resolves cleanly when a previously-active session
 *     transitions to a quiescent state mid-drain — simulating what
 *     happens during force-install where the IPC handler aborts
 *     active runs and they settle within the 5 s force-drain window.
 *   • sleeping-tool is NOT in the active set (the v0.1.2 fix the user
 *     hit on upgrade): a session asleep on WaitForTime should never
 *     block a quiesce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ----- Mock fixtures (mutable across tests) ------------------------------

const _byState = new Map<string, Array<{ id: string }>>();

function setSessionsInState(state: string, ids: string[]): void {
  _byState.set(
    state,
    ids.map((id) => ({ id }))
  );
}

function resetFixtures(): void {
  _byState.clear();
}

vi.mock('../electron/db', () => ({
  listSessionsByState: (state: string) => _byState.get(state) ?? [],
}));

// ----- Module under test ------------------------------------------------

import {
  drainBeforeQuit,
  listActiveSessionIds,
} from '../electron/quiesceManager';

// ----- Tests -------------------------------------------------------------

beforeEach(() => {
  resetFixtures();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('listActiveSessionIds', () => {
  it('returns empty when no sessions are in active states', () => {
    expect(listActiveSessionIds()).toEqual([]);
  });

  it('returns running session ids', () => {
    setSessionsInState('running', ['s1', 's2']);
    expect(listActiveSessionIds()).toEqual(['s1', 's2']);
  });

  it('returns waiting-on-system session ids', () => {
    setSessionsInState('waiting-on-system', ['s3']);
    expect(listActiveSessionIds()).toEqual(['s3']);
  });

  it('combines running and waiting-on-system', () => {
    setSessionsInState('running', ['s1']);
    setSessionsInState('waiting-on-system', ['s2']);
    // Order is running first then waiting-on-system because of the
    // ACTIVE_STATES array ordering. This isn't a strict contract but
    // pinning it keeps surprises out of regressions.
    expect(listActiveSessionIds()).toEqual(['s1', 's2']);
  });

  it('does NOT include sleeping-tool (the v0.1.2 user-hit fix)', () => {
    // This is the exact scenario the user hit on the v0.1.1 -> v0.1.2
    // upgrade: a session asleep on WaitForTime should not block the
    // quiesce. v0.1.2 introduced the `sleeping-tool` state precisely
    // so it could be classified as quiescent.
    setSessionsInState('sleeping-tool', ['sleepy']);
    expect(listActiveSessionIds()).toEqual([]);
  });

  it('does NOT include idle / sleeping-budget / waiting-on-user', () => {
    setSessionsInState('idle', ['i1']);
    setSessionsInState('sleeping-budget', ['b1']);
    setSessionsInState('waiting-on-user', ['u1']);
    expect(listActiveSessionIds()).toEqual([]);
  });
});

describe('drainBeforeQuit', () => {
  it('resolves immediately when no active sessions', async () => {
    const elapsed = await drainBeforeQuit({ timeoutMs: 1000 });
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('rejects with a message naming stuck sessions on timeout', async () => {
    setSessionsInState('running', ['abc12345-rest-of-uuid']);
    setSessionsInState('waiting-on-system', ['def67890-rest-of-uuid']);
    await expect(drainBeforeQuit({ timeoutMs: 100 })).rejects.toThrow(
      /2 session\(s\) still active/
    );
  });

  it('error message contains the abbreviated stuck ids', async () => {
    setSessionsInState('running', ['abc12345-rest-of-uuid']);
    let err: Error | null = null;
    try {
      await drainBeforeQuit({ timeoutMs: 80 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    // Message must say "stuck: abc12345" (abbreviated to 8 chars) so
    // the renderer can include it in the banner. Brittle on purpose:
    // UpdateBanner's `isQuiesceTimeoutError` regex is matched against
    // this exact wording.
    expect(err!.message).toContain('stuck: abc12345');
    expect(err!.message).toContain('Force-install would lose');
  });

  it('error message text matches the UpdateBanner heuristic regex', async () => {
    // Defense-in-depth: the renderer's `isQuiesceTimeoutError` uses a
    // regex to decide whether to surface the Force button. If the
    // wording here ever changes, the banner will silently stop
    // exposing Force install. This test catches that drift.
    setSessionsInState('running', ['s1']);
    let msg = '';
    try {
      await drainBeforeQuit({ timeoutMs: 60 });
    } catch (e) {
      msg = (e as Error).message;
    }
    const heuristic = /quiesce timed out|still active after \d+ms|drain timed out/i;
    expect(heuristic.test(msg)).toBe(true);
  });

  it('resolves cleanly when active sessions transition mid-drain', async () => {
    // Force-install scenario: the IPC handler called cancelRun on
    // each active session, which (eventually) flips them out of
    // active states. drainBeforeQuit polls every 250 ms and should
    // resolve as soon as the active list goes empty.
    setSessionsInState('running', ['victim']);
    // Schedule the transition to happen well before the timeout.
    setTimeout(() => {
      setSessionsInState('running', []);
    }, 300);
    const elapsed = await drainBeforeQuit({ timeoutMs: 5000 });
    // The drain shouldn't have taken anywhere near the full timeout.
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });
});
