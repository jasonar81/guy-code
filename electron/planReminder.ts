/**
 * Runtime nudge to keep the plan panel current.
 *
 * The system prompt already tells the model to update TodoWrite as it works.
 * Measured across 7 days of real transcripts that instruction alone does not
 * hold: 55% of turns with 6+ tool calls never touched the plan, and 805 turns
 * ended 20 or more tool calls after their last update - the stale panel the
 * user keeps having to ask about. This decides, from simple counters, when the
 * agent loop should append a short reminder alongside the next tool results.
 */

/** Tool calls without a plan update before the first reminder. */
export const PLAN_REMINDER_AFTER = 12;
/** Cap per turn so a model that ignores it is not nagged endlessly. */
export const MAX_PLAN_REMINDERS = 3;

export function stalePlanReminder(args: {
  toolCallsSincePlanUpdate: number;
  hasActivePlan: boolean;
  remindersSent: number;
}): string | null {
  if (args.remindersSent >= MAX_PLAN_REMINDERS) return null;
  if (args.toolCallsSincePlanUpdate < PLAN_REMINDER_AFTER) return null;
  const n = args.toolCallsSincePlanUpdate;
  return args.hasActivePlan
    ? `[plan check] ${n} tool calls since the plan panel was last updated. If any ` +
        `step has started or finished, or the work has changed direction, call ` +
        `TodoWrite now so the user's panel matches what you are actually doing. ` +
        `If it is genuinely still accurate, carry on.`
    : `[plan check] ${n} tool calls so far with no plan on the user's panel. This ` +
        `is multi-step work: call TodoWrite now with the steps (marking what is ` +
        `already done) so the user can follow progress.`;
}
