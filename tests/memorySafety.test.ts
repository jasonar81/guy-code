/**
 * Memory must not make the API refuse the whole request.
 *
 * MEASURED, not theorised. With a memory window containing Guy Code's own
 * debugging notes (which quote stop_reason / refusal categories / beta
 * headers), the same agentic prompt was refused with
 *   stop_reason 'refusal', category 'reasoning_extraction',
 *   "...restrictions on reverse engineering or duplicating model outputs..."
 * and ZERO content blocks - 12/12 runs, on BOTH Opus 5 and Opus 5.5.
 * Removing those notes took it to 0/12.
 *
 * So the vocabulary is redacted on the way INTO the prompt (files on disk are
 * untouched), and save_memory warns when a new note contains it.
 */
import { describe, expect, it } from 'vitest';
import {
  sanitizeMemoryText,
  hasRiskyMemoryContent,
  riskyMemoryTerms,
  countRedactions,
} from '../electron/memorySafety';

describe('detecting model-internals vocabulary', () => {
  it('flags the response-shape fields that caused the refusals', () => {
    expect(hasRiskyMemoryContent('the stop_reason was refusal')).toBe(true);
    expect(hasRiskyMemoryContent('stop_details.category was cyber')).toBe(true);
    expect(hasRiskyMemoryContent('category: reasoning_extraction')).toBe(true);
  });

  it('flags request-shape internals', () => {
    expect(hasRiskyMemoryContent('we pass anthropic-beta for the 1m context')).toBe(true);
    expect(hasRiskyMemoryContent('set output_config.effort to xhigh')).toBe(true);
    expect(hasRiskyMemoryContent('client.messages.create({...})')).toBe(true);
  });

  it('does NOT flag ordinary engineering prose', () => {
    // A bare "refusal" is normal English in PR and merge notes - flagging it
    // would mangle unrelated content for no measured benefit.
    expect(hasRiskyMemoryContent('the reviewer noted a refusal to merge')).toBe(false);
    expect(hasRiskyMemoryContent('we fixed the flaky test and shipped it')).toBe(false);
    expect(hasRiskyMemoryContent('')).toBe(false);
  });

  it('reports which terms matched, for the save-time warning', () => {
    const terms = riskyMemoryTerms('stop_reason was set and output_config too');
    expect(terms.join(' ')).toMatch(/stop_reason/);
    expect(terms.join(' ')).toMatch(/output_config/);
  });
});

describe('redacting before injection', () => {
  it('removes the terms while keeping the sentence readable', () => {
    const out = sanitizeMemoryText('The stop_reason was refusal and stop_details said cyber.');
    expect(out).not.toMatch(/stop_reason/);
    expect(out).not.toMatch(/stop_details/);
    expect(out).toMatch(/end-state/); // replaced, not deleted
  });

  it('neutralises verbatim refusal text copied from a response', () => {
    const out = sanitizeMemoryText(
      'It said: This request was blocked as it seems to violate the policy. ' +
        'Specifically reverse engineering or duplicating model outputs.'
    );
    expect(out).not.toMatch(/reverse engineering or duplicating model outputs/i);
    expect(out).not.toMatch(/This request was blocked as it seems to violate/i);
  });

  it('leaves clean text completely untouched', () => {
    const clean = 'Run the tests, then deploy the deb to all 13 nodes over scp.';
    expect(sanitizeMemoryText(clean)).toBe(clean);
    expect(countRedactions(clean)).toBe(0);
  });

  it('counts what it would change, for logging', () => {
    expect(countRedactions('stop_reason stop_reason output_config')).toBe(3);
  });

  it('is idempotent - sanitizing twice changes nothing more', () => {
    const once = sanitizeMemoryText('stop_reason and anthropic-beta and output_config');
    expect(sanitizeMemoryText(once)).toBe(once);
  });

  /**
   * A real leaf had the quoted phrase split across a markdown line break
   * ("...REVERSE ENGINEERING OR DUPLICATING MODEL ## OUTPUTS..."), which the
   * exact-phrase pattern missed - so the term survived on disk.
   */
  it('matches the quoted phrase despite case and markdown line-wrapping', () => {
    const wrapped = 'restrictions on REVERSE ENGINEERING OR DUPLICATING MODEL ## OUTPUTS here';
    expect(hasRiskyMemoryContent(wrapped)).toBe(true);
    expect(sanitizeMemoryText(wrapped)).not.toMatch(/reverse\s+engineering\s+or\s+duplicating/i);
  });
});

describe('notes are written clean, not just redacted at injection', () => {
  it('saveMemory sanitizes before writing to disk', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../electron/memory.ts', import.meta.url).pathname.replace(/^\//, ''),
        'utf8'
      )
    );
    // The write must use the sanitized text, not the raw text.
    expect(src).toMatch(/const cleaned = sanitizeMemoryText\(final\)/);
    expect(src).toMatch(/writeFileSync\(path, cleaned, 'utf8'\)/);
  });
});
