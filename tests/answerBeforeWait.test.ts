/**
 * The model must not answer a user's question with a silent wait.
 *
 * THE BUG: the user asks "is it done?" / "give me an estimate"; the model
 * runs a check, gets the data, and calls WaitForCondition with NO reply text.
 * A wait suspends the session, so the answer is never written - the user sees
 * a tool card and silence for hours. Measured across real transcripts: 30-50%
 * of user turns ending in a wait had no reply on Opus 5, 71-83% on Opus 5.5.
 *
 * Asking the model to reply first does not work (replayed on the real failing
 * moment: ignored 9/9). The guard holds the wait and sends the next request
 * with tool_choice none, so the model has to write - then lets it re-issue
 * the wait. Replayed end to end: answered 8/8, monitoring resumed 8/8.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const agent = readFileSync(join(__dirname, '..', 'electron', 'agent.ts'), 'utf8');
const anthropic = readFileSync(join(__dirname, '..', 'electron', 'anthropic.ts'), 'utf8');

const guardAt = agent.indexOf('---- Answer-before-wait guard');
const guard = agent.slice(guardAt, guardAt + 6000);

describe('the guard only fires when a reply is genuinely owed', () => {
  it('requires a real user message, not a wake-up note', () => {
    expect(agent).toMatch(/const isWakeNote = \/\^\\s\*\\\[\(WaitFor\\w\+\|wake\|resume\)\/i/);
    expect(agent).toMatch(/let answerOwedToUser =\s*\n?\s*\(effectiveText\.trim\(\)\.length > 0 \|\| attachments\.length > 0\) && !isWakeNote/);
  });

  it('requires that nothing was said since the last tool result', () => {
    expect(guard).toMatch(/textSinceLastToolResult\.trim\(\)\.length === 0/);
    // ...and resets that counter when new tool output arrives.
    expect(agent).toMatch(/textSinceLastToolResult = '';\s*\n\s*if \(interrupts\.length > 0\)/);
  });

  it('requires the response itself to have no text', () => {
    expect(guard).toMatch(/\.filter\(\(b: any\) => b\.type === 'text'\)/);
  });

  it('only fires for waits that SUSPEND (not WaitForUser, not ordinary tools)', () => {
    expect(agent).toMatch(/const SUSPENDING_TOOLS = new Set\(\[/);
    const set = agent.slice(agent.indexOf('const SUSPENDING_TOOLS'), agent.indexOf('const SUSPENDING_TOOLS') + 300);
    for (const n of ['WaitForCondition', 'WaitForTime', 'WaitForFile', 'WaitForProcess', 'WaitForHttp']) {
      expect(set).toContain(`'${n}'`);
    }
    expect(set).not.toContain("'WaitForUser'");
    expect(guard).toMatch(/toolUses\.some\(\(tu\) => SUSPENDING_TOOLS\.has\(tu\.name\)\)/);
  });

  it('is bounded so a stubborn model cannot loop forever', () => {
    expect(agent).toMatch(/const MAX_ANSWER_GUARDS = \d+/);
    expect(guard).toMatch(/answerGuardUsed < MAX_ANSWER_GUARDS/);
  });

  it('a mid-turn user message makes a reply owed again', () => {
    // all three interrupt drain points re-arm the guard
    const rearms = agent.match(/answerOwedToUser = true;\s*\n\s*answerGuardUsed = 0;/g) ?? [];
    expect(rearms.length).toBeGreaterThanOrEqual(3);
  });
});

describe('when it fires', () => {
  it('does NOT run the wait - every tool_use gets a well-formed result', () => {
    expect(guard).toMatch(/const skipped = toolUses\.map\(\(tu\) => \(\{\s*\n?\s*type: 'tool_result'/);
    expect(guard).toMatch(/tool_use_id: tu\.id/);
  });

  it('forces the next request to be tool-less (a message alone is ignored)', () => {
    expect(guard).toMatch(/forceReplyNext = true;/);
    expect(agent).toMatch(/toolChoiceNone: forceReplyNext,/);
    expect(anthropic).toMatch(/if \(args\.toolChoiceNone\) requestBody\.tool_choice = \{ type: 'none' \}/);
  });

  it('the force is one-shot - cleared as soon as a response lands', () => {
    expect(agent).toMatch(/const wasForcedReply = forceReplyNext;\s*\n\s*forceReplyNext = false;/);
  });

  it('gives the model a round to re-issue its wait after replying', () => {
    // Otherwise the tool-less reply would end the turn and drop monitoring.
    const after = agent.slice(agent.indexOf('const wasForcedReply'), agent.indexOf('const wasForcedReply') + 1500);
    expect(after).toMatch(/if \(toolUses\.length === 0\)/);
    expect(after).toMatch(/call the wait\s*'\s*\+\s*'again now to resume it/);
    expect(after).toMatch(/continue;/);
  });

  it('persists the held turn so the transcript stays well-formed', () => {
    expect(guard).toMatch(/appendJsonlEvent\(ourPath/);
  });
});

describe('the system prompt states the rule too', () => {
  it('tells the model to answer before waiting', () => {
    expect(anthropic).toMatch(/ANSWER BEFORE YOU WAIT/);
    expect(anthropic).toMatch(/Checking data and then going straight back to waiting is not answering/);
  });
});
