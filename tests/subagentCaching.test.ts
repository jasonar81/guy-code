/**
 * Subagent requests must use prompt caching.
 *
 * They did not, and it was the single largest line on the bill. Over 30 days:
 * 48,216 subagent calls with ZERO cache reads and ZERO cache writes, 8.57B
 * input tokens, $36,908 - 54% of all spend. Prompts grew past 600K tokens and
 * were re-sent at full price every round, because
 *   - buildRoleSystemPrompt returned a plain STRING, so no cache_control
 *     could be attached to the system prompt, and
 *   - the subagent loop never called withConversationCacheBreakpoint.
 *
 * Verified against the live API: the old shape billed 15,843 input tokens on
 * both of two identical calls; the new shape wrote 15,839 once and then read
 * them back, paying for 4.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sub = readFileSync(join(__dirname, '..', 'electron', 'subagent.ts'), 'utf8');
const anth = readFileSync(join(__dirname, '..', 'electron', 'anthropic.ts'), 'utf8');

describe('subagent system prompt is cacheable', () => {
  it('is sent as blocks, not a bare string', () => {
    expect(sub).toMatch(/function buildRoleSystemBlocks\(/);
    expect(sub).toMatch(/const system = buildRoleSystemBlocks\(input\.role, parent\.cwd\);/);
    // The old call site must be gone, or nothing is cached.
    expect(sub).not.toMatch(/const system = buildRoleSystemPrompt\(/);
  });

  it('carries a 1h cache breakpoint', () => {
    const at = sub.indexOf('function buildRoleSystemBlocks');
    expect(sub.slice(at, at + 700)).toMatch(/cache_control: CACHE_1H/);
  });
});

describe('subagent conversation is cacheable', () => {
  it('the request wraps messages with the conversation breakpoint', () => {
    expect(sub).toMatch(/messages: withConversationCacheBreakpoint\(messages\)/);
  });

  it('imports the helper rather than re-implementing it', () => {
    expect(sub).toMatch(/withConversationCacheBreakpoint,/);
    expect(anth).toMatch(/export function withConversationCacheBreakpoint/);
  });
});

describe('the refusal pin expires', () => {
  const agent = readFileSync(join(__dirname, '..', 'electron', 'agent.ts'), 'utf8');

  it('a refusal records WHEN it happened', () => {
    expect(agent).toMatch(/setSetting\(`session_refused_at_\$\{sessionId\}`, String\(Date\.now\(\)\)\)/);
  });

  it('an expired pin is cleared and the preferred model retried', () => {
    expect(agent).toMatch(/const pinExpired = pinnedAt > 0 && Date\.now\(\) - pinnedAt > REFUSAL_PIN_MS;/);
    expect(agent).toMatch(/if \(pinExpired\) \{[\s\S]{0,260}setSetting\(`session_refused_\$\{sessionId\}`, '0'\)/);
  });

  it('the pin is not consulted once expired', () => {
    expect(agent).toMatch(/!pinExpired &&\s*\n\s*getSetting\(`session_refused_\$\{sessionId\}`\) === '1'/);
  });

  it('the window is short enough to matter but not thrash', async () => {
    const { REFUSAL_PIN_MS } = await import('../electron/anthropic');
    expect(REFUSAL_PIN_MS).toBeGreaterThanOrEqual(60_000);
    expect(REFUSAL_PIN_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});
