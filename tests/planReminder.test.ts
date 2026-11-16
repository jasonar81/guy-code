/**
 * Keeping the plan panel current needs more than the system-prompt rule.
 *
 * Measured over 7 days of real transcripts: 55% of turns with 6+ tool calls
 * never touched the plan, and 805 turns ended 20+ tool calls after their last
 * update. Replaying 7 real stale moments, the next response updated the plan
 * 3/7 times without a reminder and 7/7 with one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stalePlanReminder, PLAN_REMINDER_AFTER, MAX_PLAN_REMINDERS } from '../electron/planReminder';

describe('stalePlanReminder', () => {
  it('stays quiet until enough tool calls have run since the last plan update', () => {
    expect(stalePlanReminder({ toolCallsSincePlanUpdate: PLAN_REMINDER_AFTER - 1, hasActivePlan: true, remindersSent: 0 })).toBeNull();
    expect(stalePlanReminder({ toolCallsSincePlanUpdate: PLAN_REMINDER_AFTER, hasActivePlan: true, remindersSent: 0 })).not.toBeNull();
  });

  it('asks for a plan when there is none, and an update when there is one', () => {
    const none = stalePlanReminder({ toolCallsSincePlanUpdate: 15, hasActivePlan: false, remindersSent: 0 })!;
    const some = stalePlanReminder({ toolCallsSincePlanUpdate: 15, hasActivePlan: true, remindersSent: 0 })!;
    expect(none).toMatch(/no plan on the user's panel/);
    expect(some).toMatch(/since the plan panel was last updated/);
    expect(some).toMatch(/If it is genuinely still accurate, carry on/);
  });

  it('is capped per turn', () => {
    expect(stalePlanReminder({ toolCallsSincePlanUpdate: 99, hasActivePlan: true, remindersSent: MAX_PLAN_REMINDERS })).toBeNull();
  });
});

describe('agent loop wiring', () => {
  const src = readFileSync(join(__dirname, '..', 'electron', 'agent.ts'), 'utf8');

  it('counts tool calls and resets on TodoWrite / PlanState', () => {
    expect(src).toMatch(/if \(tu\.name === 'TodoWrite' \|\| tu\.name === 'PlanState'\) toolCallsSincePlanUpdate = 0;/);
    expect(src).toMatch(/else toolCallsSincePlanUpdate\+\+;/);
  });

  it('appends the reminder alongside the tool results, then resets the window', () => {
    expect(src).toMatch(/const planReminder = stalePlanReminder\(\{/);
    expect(src).toMatch(/userBlocks\.push\(\{ type: 'text', text: planReminder \}\)/);
    expect(src).toMatch(/planRemindersSent\+\+;\s*\n\s*toolCallsSincePlanUpdate = 0;/);
  });
});
