/**
 * Tests for `electron/planManager.ts` — the TodoWrite + PlanState
 * handlers and the active-plan system-prompt block formatter.
 *
 * Coverage target:
 *   • TodoWrite auto-creates an active plan when none exists.
 *   • TodoWrite preserves step status by id when updating an existing
 *     plan (no accidental "downgrade" from in_progress → pending).
 *   • PlanState complete / abandon refuse to fire without an active
 *     plan or without an outcome_summary.
 *   • PlanState start_new with an active plan rotates atomically: old
 *     plan moves to completed/abandoned, new plan is created in
 *     active state, unique-active-per-session invariant holds.
 *   • Plan-block formatter emits the canonical shape regardless of
 *     step count or status mix.
 *
 * Strategy: mock `./db` with an in-memory plan store. We don't need
 * SQLite for any of these tests — just the get/insert/update/rotate
 * surface that planManager uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared in-memory state. Reset in beforeEach.
type PlanRow = {
  id: string;
  session_id: string;
  title: string;
  state: 'active' | 'completed' | 'abandoned';
  steps: Array<{ id: string; text: string; status: string; notes?: string }>;
  outcome_summary: string | null;
  created_at: number;
  updated_at: number;
};

const _state = vi.hoisted(() => {
  return {
    plans: new Map<string, any>(), // id -> row
  };
});

vi.mock('../electron/db', () => {
  return {
    getActivePlan: (sessionId: string) => {
      for (const p of _state.plans.values()) {
        if (p.session_id === sessionId && p.state === 'active') return p;
      }
      return null;
    },
    listPlansForSession: (sessionId: string) => {
      return [..._state.plans.values()]
        .filter((p) => p.session_id === sessionId)
        .sort((a, b) => b.created_at - a.created_at);
    },
    createPlan: (args: any) => {
      _state.plans.set(args.id, {
        id: args.id,
        session_id: args.sessionId,
        title: args.title,
        state: 'active',
        steps: args.steps,
        outcome_summary: null,
        created_at: args.ts,
        updated_at: args.ts,
      });
    },
    updatePlanSteps: (args: any) => {
      const p = _state.plans.get(args.id);
      if (p) {
        p.steps = args.steps;
        p.updated_at = args.ts;
      }
    },
    setPlanState: (args: any) => {
      const p = _state.plans.get(args.id);
      if (p && p.state === 'active') {
        p.state = args.state;
        p.outcome_summary = args.summary;
        p.updated_at = args.ts;
      }
    },
    rotateActivePlan: (args: any) => {
      // Find existing active for this session, finalize it, then insert new.
      for (const p of _state.plans.values()) {
        if (p.session_id === args.sessionId && p.state === 'active') {
          p.state = args.previousOutcome;
          p.outcome_summary = args.previousSummary;
          p.updated_at = args.ts;
        }
      }
      _state.plans.set(args.newId, {
        id: args.newId,
        session_id: args.sessionId,
        title: args.newTitle,
        state: 'active',
        steps: args.newSteps,
        outcome_summary: null,
        created_at: args.ts,
        updated_at: args.ts,
      });
    },
  };
});

import {
  persistTodoWrite,
  handlePlanState,
  formatActivePlanBlock,
} from '../electron/planManager';

beforeEach(() => {
  _state.plans.clear();
});

afterEach(() => {
  _state.plans.clear();
});

function activeFor(sessionId: string): PlanRow | null {
  for (const p of _state.plans.values()) {
    if (p.session_id === sessionId && p.state === 'active') return p as PlanRow;
  }
  return null;
}

function allFor(sessionId: string): PlanRow[] {
  return [..._state.plans.values()]
    .filter((p) => p.session_id === sessionId)
    .sort((a, b) => b.created_at - a.created_at) as PlanRow[];
}

// ---- TodoWrite ---------------------------------------------------------

describe('persistTodoWrite', () => {
  it('auto-creates an active plan when none exists', () => {
    const r = persistTodoWrite({
      sessionId: 's1',
      todos: [
        { id: '1', content: 'first step', status: 'pending' },
        { id: '2', content: 'second step', status: 'pending' },
      ],
      title: null,
    });
    expect(r).toMatch(/created plan/);
    const active = activeFor('s1');
    expect(active).not.toBeNull();
    expect(active!.steps).toHaveLength(2);
    expect(active!.title).toBe('first step');
  });

  it('uses an explicit title when provided', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: '1', content: 'do thing', status: 'pending' }],
      title: 'Custom Plan Title',
    });
    expect(activeFor('s1')!.title).toBe('Custom Plan Title');
  });

  it('updates an existing active plan in place (preserves id)', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'first', status: 'pending' }],
      title: null,
    });
    const firstId = activeFor('s1')!.id;
    persistTodoWrite({
      sessionId: 's1',
      todos: [
        { id: 'a', content: 'first revised', status: 'pending' },
        { id: 'b', content: 'second new', status: 'pending' },
      ],
      title: null,
    });
    expect(activeFor('s1')!.id).toBe(firstId); // same plan
    expect(activeFor('s1')!.steps).toHaveLength(2);
  });

  it('preserves status when updating: in_progress → pending is BLOCKED', () => {
    // Seed: step A is in_progress.
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'doing', status: 'in_progress' }],
      title: null,
    });
    expect(activeFor('s1')!.steps[0].status).toBe('in_progress');
    // Model issues a routine update with same id but pending status.
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'doing', status: 'pending' }],
      title: null,
    });
    expect(activeFor('s1')!.steps[0].status).toBe('in_progress');
  });

  it('allows in_progress → completed transitions', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'x', status: 'in_progress' }],
      title: null,
    });
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'x', status: 'completed' }],
      title: null,
    });
    expect(activeFor('s1')!.steps[0].status).toBe('completed');
  });

  it('drops todos with empty content and assigns missing ids', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [
        { id: '', content: '', status: 'pending' }, // dropped (empty content)
        { id: '', content: 'real step', status: 'pending' }, // kept, id assigned
      ],
      title: null,
    });
    const active = activeFor('s1');
    expect(active!.steps).toHaveLength(1);
    expect(active!.steps[0].id.length).toBeGreaterThan(0);
    expect(active!.steps[0].text).toBe('real step');
  });
});

// ---- PlanState ---------------------------------------------------------

describe('handlePlanState', () => {
  it('refuses complete/abandon when no active plan exists', () => {
    const r = handlePlanState({
      sessionId: 's1',
      action: 'complete',
      outcomeSummary: 'done',
      previousOutcome: null,
      nextTitle: null,
      nextSteps: null,
    });
    expect(r).toMatch(/^error: no active plan/);
  });

  it('requires outcome_summary for complete/abandon', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'x', status: 'pending' }],
      title: null,
    });
    const r = handlePlanState({
      sessionId: 's1',
      action: 'complete',
      outcomeSummary: null,
      previousOutcome: null,
      nextTitle: null,
      nextSteps: null,
    });
    expect(r).toMatch(/^error: outcome_summary is required/);
    expect(activeFor('s1')).not.toBeNull(); // still active
  });

  it('completes an active plan', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'x', status: 'completed' }],
      title: null,
    });
    handlePlanState({
      sessionId: 's1',
      action: 'complete',
      outcomeSummary: 'shipped successfully',
      previousOutcome: null,
      nextTitle: null,
      nextSteps: null,
    });
    expect(activeFor('s1')).toBeNull();
    const all = allFor('s1');
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe('completed');
    expect(all[0].outcome_summary).toBe('shipped successfully');
  });

  it('abandons an active plan', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'x', status: 'pending' }],
      title: null,
    });
    handlePlanState({
      sessionId: 's1',
      action: 'abandon',
      outcomeSummary: 'user redirected',
      previousOutcome: null,
      nextTitle: null,
      nextSteps: null,
    });
    expect(activeFor('s1')).toBeNull();
    const all = allFor('s1');
    expect(all[0].state).toBe('abandoned');
  });

  it('start_new without active plan creates a new one and ignores outcome', () => {
    handlePlanState({
      sessionId: 's1',
      action: 'start_new',
      outcomeSummary: null,
      previousOutcome: null,
      nextTitle: 'Fresh plan',
      nextSteps: [{ id: 'a', content: 'first step', status: 'pending' }],
    });
    expect(activeFor('s1')).not.toBeNull();
    expect(activeFor('s1')!.title).toBe('Fresh plan');
    expect(allFor('s1')).toHaveLength(1);
  });

  it('start_new with active plan rotates atomically', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'old plan step', status: 'completed' }],
      title: 'Old plan',
    });
    handlePlanState({
      sessionId: 's1',
      action: 'start_new',
      outcomeSummary: 'old plan finished',
      previousOutcome: 'completed',
      nextTitle: 'New plan',
      nextSteps: [{ id: 'x', content: 'new first step', status: 'pending' }],
    });
    const all = allFor('s1');
    expect(all).toHaveLength(2);
    // Sort by state for deterministic indexing — created_at can collide
    // when both rows land in the same millisecond.
    const active = all.find((p) => p.state === 'active');
    const completed = all.find((p) => p.state === 'completed');
    expect(active).toBeDefined();
    expect(active!.title).toBe('New plan');
    expect(completed).toBeDefined();
    expect(completed!.title).toBe('Old plan');
    expect(completed!.outcome_summary).toBe('old plan finished');
  });

  it('start_new requires next_title', () => {
    const r = handlePlanState({
      sessionId: 's1',
      action: 'start_new',
      outcomeSummary: null,
      previousOutcome: null,
      nextTitle: null,
      nextSteps: [{ id: 'a', content: 'x', status: 'pending' }],
    });
    expect(r).toMatch(/^error: next_title is required/);
  });

  it('start_new requires non-empty next_steps', () => {
    const r = handlePlanState({
      sessionId: 's1',
      action: 'start_new',
      outcomeSummary: null,
      previousOutcome: null,
      nextTitle: 'X',
      nextSteps: [],
    });
    expect(r).toMatch(/^error: next_steps must be a non-empty array/);
  });

  it('start_new with active plan requires previous_outcome', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'x', status: 'pending' }],
      title: null,
    });
    const r = handlePlanState({
      sessionId: 's1',
      action: 'start_new',
      outcomeSummary: 'doing fine',
      previousOutcome: null,
      nextTitle: 'New',
      nextSteps: [{ id: 'b', content: 'y', status: 'pending' }],
    });
    expect(r).toMatch(/^error: previous_outcome is required/);
  });

  it('multi-session isolation: completing s1 plan does not touch s2', () => {
    persistTodoWrite({
      sessionId: 's1',
      todos: [{ id: 'a', content: 'x', status: 'pending' }],
      title: null,
    });
    persistTodoWrite({
      sessionId: 's2',
      todos: [{ id: 'b', content: 'y', status: 'pending' }],
      title: null,
    });
    handlePlanState({
      sessionId: 's1',
      action: 'complete',
      outcomeSummary: 'done',
      previousOutcome: null,
      nextTitle: null,
      nextSteps: null,
    });
    expect(activeFor('s1')).toBeNull();
    expect(activeFor('s2')).not.toBeNull();
  });
});

// ---- formatActivePlanBlock --------------------------------------------

describe('formatActivePlanBlock', () => {
  it('emits ACTIVE PLAN header + per-step lines + tool reminder', () => {
    const out = formatActivePlanBlock({
      id: 'p1',
      session_id: 's1',
      title: 'Build feature X',
      state: 'active',
      steps: [
        { id: '1', text: 'step one', status: 'completed' },
        { id: '2', text: 'step two', status: 'in_progress' },
        { id: '3', text: 'step three', status: 'pending' },
      ],
      outcome_summary: null,
      created_at: 0,
      updated_at: 0,
    });
    expect(out).toMatch(/ACTIVE PLAN: Build feature X/);
    expect(out).toMatch(/\[done\] +1\. step one/);
    expect(out).toMatch(/\[active\] +2\. step two/);
    expect(out).toMatch(/\[pending\] +3\. step three/);
    expect(out).toMatch(/Update steps with TodoWrite/);
    expect(out).toMatch(/PlanState/);
  });

  it('includes inline notes under their step', () => {
    const out = formatActivePlanBlock({
      id: 'p1',
      session_id: 's1',
      title: 'X',
      state: 'active',
      steps: [
        { id: '1', text: 'one', status: 'in_progress', notes: 'blocked on code review' },
      ],
      outcome_summary: null,
      created_at: 0,
      updated_at: 0,
    });
    expect(out).toMatch(/blocked on code review/);
  });

  it('handles a plan with zero steps', () => {
    const out = formatActivePlanBlock({
      id: 'p1',
      session_id: 's1',
      title: 'Empty plan',
      state: 'active',
      steps: [],
      outcome_summary: null,
      created_at: 0,
      updated_at: 0,
    });
    expect(out).toMatch(/no steps recorded yet/);
  });
});
