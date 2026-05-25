/**
 * Plan persistence + lifecycle management.
 *
 * Layered on top of the `plans` table from migration v6 in `db.ts`. The
 * model never sees this module directly — it goes through two tools:
 *
 *   • TodoWrite        → `persistTodoWrite`  (auto-create or update active)
 *   • PlanState        → `handlePlanState`   (complete / abandon / start_new)
 *
 * The user sees the active plan two ways:
 *   • System-prompt block injected on every API call (see
 *     `renderActivePlanBlock` below; called from `agent.ts`).
 *   • UI panel `CurrentPlanPanel` reading via IPC (see `ipc.ts`).
 *
 * Design note: TodoWrite was historically a "noop tool that just told
 * the UI what to render". With v6 it gains real persistence semantics
 * but the input schema is preserved for back-compat — pre-existing
 * model habits keep working, the data just sticks now.
 */
import { randomUUID } from 'node:crypto';
import log from 'electron-log';
import {
  getActivePlan,
  createPlan,
  updatePlanSteps,
  setPlanState,
  rotateActivePlan,
  type PlanRow,
  type PlanStep,
} from './db';

// ---------------------------------------------------------------------
// TodoWrite handler
// ---------------------------------------------------------------------

interface TodoInput {
  id: string;
  content: string;
  status: PlanStep['status'];
  notes?: string;
}

interface PersistTodoWriteArgs {
  sessionId: string;
  todos: TodoInput[];
  title: string | null;
}

/**
 * Wholesale-replace the active plan's steps. Auto-creates an active
 * plan if none exists. Status of pre-existing steps is preserved when
 * the model passes the same id (so "agent updated step 3 wording" doesn't
 * lose the in-progress flag the user manually set, etc.).
 *
 * Returns a short string the model will see as the tool result.
 */
export function persistTodoWrite(args: PersistTodoWriteArgs): string {
  const ts = Date.now();
  const incoming = normalizeTodos(args.todos);
  const active = getActivePlan(args.sessionId);

  if (!active) {
    // No active plan — auto-create one. Title defaults to the first
    // incomplete step (or the first step) if the model didn't supply one.
    const titleFromSteps =
      incoming.find((s) => s.status !== 'completed')?.text ??
      incoming[0]?.text ??
      'Untitled plan';
    const title = (args.title ?? titleFromSteps).trim() || 'Untitled plan';
    const newId = randomUUID();
    createPlan({
      id: newId,
      sessionId: args.sessionId,
      title,
      steps: incoming,
      ts,
    });
    log.info(
      `[plan] created plan ${newId.slice(0, 8)} for session ${args.sessionId.slice(0, 8)} with ${incoming.length} step(s)`
    );
    return `noted ${incoming.length} todo(s); created plan "${title}".`;
  }

  // Existing active plan — merge step status by id so we don't reset
  // an in-progress flag the user may have already advanced.
  const merged = mergeStepStatuses(active.steps, incoming);
  updatePlanSteps({ id: active.id, steps: merged, ts });
  return `noted ${merged.length} todo(s); plan "${active.title}" updated.`;
}

/**
 * For each incoming step, if its id matches an existing step in the
 * active plan AND the incoming status is 'pending' while the existing
 * is more advanced, keep the existing status. This lets the model
 * issue routine TodoWrite calls without inadvertently "downgrading"
 * a step that's already in_progress / completed via a different path.
 *
 * Steps without matching ids are kept as the model passed them.
 */
function mergeStepStatuses(prev: PlanStep[], next: PlanStep[]): PlanStep[] {
  const prevById = new Map(prev.map((s) => [s.id, s]));
  return next.map((n) => {
    const p = prevById.get(n.id);
    if (!p) return n;
    // Don't downgrade in_progress/completed → pending.
    if (n.status === 'pending' && (p.status === 'in_progress' || p.status === 'completed')) {
      return { ...n, status: p.status };
    }
    return n;
  });
}

function normalizeTodos(todos: TodoInput[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const raw of todos ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : randomUUID().slice(0, 8);
    const text = typeof raw.content === 'string' ? raw.content.trim() : '';
    if (!text) continue;
    const status = isValidStatus(raw.status) ? raw.status : 'pending';
    const step: PlanStep = { id, text, status };
    if (typeof raw.notes === 'string' && raw.notes.trim()) {
      step.notes = raw.notes.trim();
    }
    out.push(step);
  }
  return out;
}

function isValidStatus(s: unknown): s is PlanStep['status'] {
  return s === 'pending' || s === 'in_progress' || s === 'completed' || s === 'cancelled';
}

// ---------------------------------------------------------------------
// PlanState handler (lifecycle)
// ---------------------------------------------------------------------

interface HandlePlanStateArgs {
  sessionId: string;
  action: 'complete' | 'abandon' | 'start_new';
  outcomeSummary: string | null;
  previousOutcome: 'completed' | 'abandoned' | null;
  nextTitle: string | null;
  nextSteps: TodoInput[] | null;
}

export function handlePlanState(args: HandlePlanStateArgs): string {
  const ts = Date.now();
  const active = getActivePlan(args.sessionId);

  if (args.action === 'complete' || args.action === 'abandon') {
    if (!active) {
      return `error: no active plan to ${args.action}. Use TodoWrite to start a plan first.`;
    }
    if (!args.outcomeSummary || !args.outcomeSummary.trim()) {
      return `error: outcome_summary is required for action="${args.action}".`;
    }
    const newState = args.action === 'complete' ? 'completed' : 'abandoned';
    setPlanState({
      id: active.id,
      state: newState,
      summary: args.outcomeSummary.trim(),
      ts,
    });
    log.info(
      `[plan] plan ${active.id.slice(0, 8)} → ${newState}: ${args.outcomeSummary.slice(0, 80)}`
    );
    return `plan "${active.title}" marked ${newState}. There is no active plan now; use TodoWrite to start a fresh one when ready.`;
  }

  // action === 'start_new'
  if (!args.nextTitle || !args.nextTitle.trim()) {
    return 'error: next_title is required for action="start_new".';
  }
  const nextSteps = normalizeTodos(args.nextSteps ?? []);
  if (nextSteps.length === 0) {
    return 'error: next_steps must be a non-empty array for action="start_new".';
  }
  const newId = randomUUID();
  if (active) {
    if (!args.previousOutcome) {
      return 'error: previous_outcome is required when starting a new plan while one is active.';
    }
    if (!args.outcomeSummary || !args.outcomeSummary.trim()) {
      return 'error: outcome_summary is required when starting a new plan while one is active.';
    }
    rotateActivePlan({
      newId,
      sessionId: args.sessionId,
      newTitle: args.nextTitle.trim(),
      newSteps: nextSteps,
      previousOutcome: args.previousOutcome,
      previousSummary: args.outcomeSummary.trim(),
      ts,
    });
    log.info(
      `[plan] rotated active: ${active.id.slice(0, 8)} (${args.previousOutcome}) → ${newId.slice(0, 8)} (active)`
    );
    return `previous plan "${active.title}" marked ${args.previousOutcome}; new plan "${args.nextTitle}" is now active with ${nextSteps.length} step(s).`;
  }

  // No active plan — just create the new one. previousOutcome /
  // outcomeSummary are silently ignored; the model probably
  // forgot there wasn't an active plan and that's OK.
  createPlan({
    id: newId,
    sessionId: args.sessionId,
    title: args.nextTitle.trim(),
    steps: nextSteps,
    ts,
  });
  log.info(
    `[plan] start_new with no prior active: created ${newId.slice(0, 8)}`
  );
  return `new plan "${args.nextTitle}" created with ${nextSteps.length} step(s).`;
}

// ---------------------------------------------------------------------
// System-prompt active-plan block
// ---------------------------------------------------------------------

/**
 * Render the active-plan block injected into the system prompt before
 * every API call. Returns "" when there's no active plan so the prompt
 * stays lean for sessions that don't use the planning tools.
 *
 * The block is intentionally brief — just the title, status counts,
 * and the in-progress / next-pending steps. The model gets just
 * enough context to stay oriented without inflating every turn.
 */
export function renderActivePlanBlock(sessionId: string): string {
  const active = getActivePlan(sessionId);
  if (!active) return '';
  return formatActivePlanBlock(active);
}

/** Pure formatter — extracted so tests can exercise it without DB. */
export function formatActivePlanBlock(plan: PlanRow): string {
  const lines: string[] = [];
  lines.push(`ACTIVE PLAN: ${plan.title}`);
  lines.push('');
  if (plan.steps.length === 0) {
    lines.push('(no steps recorded yet — call TodoWrite when you have a plan)');
    return lines.join('\n');
  }
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    const tag = statusTag(s.status);
    lines.push(`  ${tag.padEnd(11)}${i + 1}. ${s.text}`);
    if (s.notes) {
      lines.push(`             ↳ ${s.notes}`);
    }
  }
  lines.push('');
  lines.push(
    'Update steps with TodoWrite. To finalize this plan or switch to a new one, use the PlanState tool (action=complete|abandon|start_new).'
  );
  return lines.join('\n');
}

function statusTag(s: PlanStep['status']): string {
  switch (s) {
    case 'completed':
      return '[done]';
    case 'in_progress':
      return '[active]';
    case 'cancelled':
      return '[cancelled]';
    case 'pending':
    default:
      return '[pending]';
  }
}
