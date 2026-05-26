/**
 * Tests for `electron/contextBailGuard.ts` — the heuristic that
 * identifies WaitForUser questions asking the user for permission to
 * keep working due to context budget / fresh-session handoff. The
 * agent loop intercepts these and forces the model to continue.
 *
 * Coverage strategy:
 *   • Every verbatim / paraphrased example the user has complained
 *     about MUST be flagged. False negatives are the actual bug.
 *   • A representative set of LEGITIMATE clarifying questions MUST
 *     NOT be flagged. False positives waste guardrail-nudge budget
 *     and could (eventually, after the cap) suppress a real user
 *     question that happened to mention context in passing.
 *   • The nudge builder produces stable text the model can rely on
 *     to recognize itself as in a guardrail state.
 */
import { describe, expect, it } from 'vitest';
import {
  buildContextBailNudge,
  looksLikeContextBail,
} from '../electron/contextBailGuard';

describe('looksLikeContextBail — flagged anti-patterns', () => {
  // The exact verbatim exemplar the user pasted as the v0.1.5 bug.
  const FLAGGED: ReadonlyArray<[string, string]> = [
    [
      "user's verbatim exemplar",
      'Push through to completion now in this same turn (will be tight against context budget), OR stop here and let a fresh session pick up from the saved memory?',
    ],
    [
      'shorter "fresh session" variant',
      'Should I push through, or let a fresh session take over?',
    ],
    [
      '"new session pick up" variant',
      'I can stop here and have a new session pick up tomorrow — your call.',
    ],
    [
      '"saved memory pick up next session"',
      "I've saved everything to memory; the next session can pick up from the saved memory leaves.",
    ],
    [
      '"context budget"',
      'Continue in this turn (context budget is getting tight) or pause and resume later?',
    ],
    [
      '"context window remaining"',
      "We're approaching the context window remaining; should I stop here?",
    ],
    [
      '"tight against context"',
      "It's going to be tight against context — continue or split this across sessions?",
    ],
    [
      '"stop here and"',
      'Want me to stop here and pick this up in a fresh session?',
    ],
    [
      '"in this same turn" phrasing',
      "I can finish this in this same turn if you're OK with that, otherwise we pause.",
    ],
    [
      '"split across sessions"',
      'Should I split this work across multiple sessions?',
    ],
    [
      '"context is getting tight"',
      'Heads up: context is getting tight — keep going or pause?',
    ],
    [
      '"OR stop" choice framing',
      'Continue to step 3 OR stop here and resume later?',
    ],
    [
      '"context pressure"',
      'Given the context pressure, want me to bail and reopen in a fresh session?',
    ],
    [
      '"push through to completion ... turn"',
      'Push through to completion in this same turn? It will be a tight fit.',
    ],
  ];

  for (const [label, q] of FLAGGED) {
    it(`flags: ${label}`, () => {
      expect(looksLikeContextBail(q)).toBe(true);
    });
  }
});

describe('looksLikeContextBail — legitimate questions that must NOT be flagged', () => {
  const SUBSTANTIVE: ReadonlyArray<[string, string]> = [
    [
      'real clarification',
      "I'm seeing two ways to fix this — A or B. Which do you prefer?",
    ],
    [
      'tool decision',
      'Should I delete the old log files now or keep them for reference?',
    ],
    [
      'data verification',
      "I found 17 entries that look like duplicates. Want me to dedupe them?",
    ],
    [
      'permission gate (legitimate)',
      'This will modify production config. OK to proceed?',
    ],
    [
      'choice between alternatives',
      "Should I use a hash map or a btree here?",
    ],
    [
      'genuine end-of-task',
      'Anything else you want me to do before I close this out?',
    ],
    [
      'incidental "context" word in non-bail meaning',
      "Quick question: in the context of this PR, do you want me to also bump the schema version?",
    ],
    [
      'incidental "turn" word',
      'Should I turn off the dev server before deploying?',
    ],
    [
      'session-related but in DIFFERENT meaning',
      'Do you want me to start a new session in the browser to test the login flow?',
    ],
    [
      'empty string',
      '',
    ],
    [
      'whitespace only',
      '   \n\t  ',
    ],
  ];

  for (const [label, q] of SUBSTANTIVE) {
    it(`does NOT flag: ${label}`, () => {
      expect(looksLikeContextBail(q)).toBe(false);
    });
  }
});

describe('buildContextBailNudge', () => {
  it('returns a non-empty string', () => {
    const s = buildContextBailNudge(1, 4);
    expect(s.length).toBeGreaterThan(50);
  });

  it('includes the SYSTEM GUARDRAIL prefix so the model recognizes the message type', () => {
    const s = buildContextBailNudge(1, 4);
    expect(s).toContain('SYSTEM GUARDRAIL');
  });

  it('includes the technical explanation of why context is automatic', () => {
    const s = buildContextBailNudge(1, 4);
    expect(s).toContain('micro-compaction');
    expect(s).toContain('preflight');
  });

  it('forbids the specific anti-pattern phrases', () => {
    const s = buildContextBailNudge(2, 4);
    expect(s).toMatch(/context\s+(pressure|budget)/i);
    expect(s).toMatch(/fresh\s+session/i);
  });

  it('signals it is the LAST nudge when nudgesUsed === maxNudges', () => {
    const s = buildContextBailNudge(4, 4);
    expect(s).toMatch(/LAST guardrail nudge/i);
    expect(s).toContain('4 / 4');
  });

  it('shows the nudge ratio for non-final calls', () => {
    const s = buildContextBailNudge(2, 4);
    expect(s).toContain('2 / 4');
    expect(s).not.toMatch(/LAST guardrail nudge/i);
  });
});
