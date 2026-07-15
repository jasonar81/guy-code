/**
 * The runaway-repetition guard that stops a model degenerating into the same
 * token/line forever (observed: a stray "court" looped 16000x and wedged a
 * session).
 */
import { describe, expect, it } from 'vitest';
import { isRunawayRepetition, trimRepetitiveTail } from '../electron/anthropic';

describe('isRunawayRepetition', () => {
  it('detects the "court" runaway (token repeated on its own lines)', () => {
    const text = 'court\n\n'.repeat(500);
    expect(isRunawayRepetition(text)).toBe(true);
  });

  it('detects a runaway with a little real text before the loop', () => {
    const text = 'Here is my analysis of the problem.\n\n' + 'court\n\n'.repeat(500);
    expect(isRunawayRepetition(text)).toBe(true);
  });

  it('detects a single repeated short line', () => {
    const text = ('the the the the the ').repeat(400);
    expect(isRunawayRepetition(text)).toBe(true);
  });

  it('does NOT trip on normal prose', () => {
    const text =
      'The reservation is still building. I checked the queue and it shows ' +
      'position two. Once it becomes active I will load the TPC-H tables and ' +
      'run the first experiment, then compare the timings against the baseline. '.repeat(
        20
      );
    expect(isRunawayRepetition(text)).toBe(false);
  });

  it('does NOT trip on a legitimate markdown table', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| row ${i} | value ${i * 3} | ${i % 2 ? 'yes' : 'no'} |`).join('\n');
    const text = '| a | b | c |\n| --- | --- | --- |\n' + rows;
    expect(isRunawayRepetition(text)).toBe(false);
  });

  it('does NOT trip on a bulleted list with varied items', () => {
    const text = Array.from({ length: 40 }, (_, i) => `- item number ${i} does something specific and different`).join('\n');
    expect(isRunawayRepetition(text)).toBe(false);
  });

  it('ignores short text (not enough to be a real loop)', () => {
    expect(isRunawayRepetition('court court court')).toBe(false);
  });
});

describe('trimRepetitiveTail', () => {
  it('keeps the real head and drops the repetitive tail', () => {
    const text = 'Here is the real analysis that matters and is a full sentence.\n\n' + 'court\n\n'.repeat(500);
    const trimmed = trimRepetitiveTail(text);
    expect(trimmed).toContain('real analysis that matters');
    expect((trimmed.match(/court/g) || []).length).toBe(0);
  });

  it('returns something even if the whole thing is noise', () => {
    const trimmed = trimRepetitiveTail('court\n'.repeat(500));
    expect(typeof trimmed).toBe('string');
  });
});
