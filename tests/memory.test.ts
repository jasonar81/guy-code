/**
 * Tests for the pure helpers in `electron/memory.ts`. The
 * file-system-touching functions (loadMemory, saveMemory, etc.) are
 * exercised via integration tests using a tmp dir, but the pure ones
 * we cover here:
 *
 *   • `claudeSlugForCwd` — translates a cwd to Claude Code's
 *     filesystem slug (drive letters → dash; sep → dash).
 *   • `recallFromBundle` — substring search over a flat memory text.
 */
import { describe, expect, it } from 'vitest';
import { claudeSlugForCwd, recallFromBundle } from '../electron/memory';

describe('claudeSlugForCwd', () => {
  it('returns empty string for empty input', () => {
    expect(claudeSlugForCwd('')).toBe('');
  });

  it('strips drive-letter colon on Windows paths', () => {
    expect(claudeSlugForCwd('C:\\Users\\jarnold\\proj')).toBe(
      'C-Users-jarnold-proj'
    );
  });

  it('converts separators to dashes', () => {
    expect(claudeSlugForCwd('/home/user/proj')).toBe('-home-user-proj');
  });

  it('handles mixed separators', () => {
    expect(claudeSlugForCwd('C:/Users/jarnold\\proj')).toBe(
      'C-Users-jarnold-proj'
    );
  });
});

describe('recallFromBundle', () => {
  const bundle = {
    text: [
      '<<< CLAUDE.md (~/.claude/CLAUDE.md) >>>',
      '',
      'Guidance: prefer TypeScript over JavaScript.',
      '',
      'Style: 2-space indent for all files.',
      '',
      '<<< MEMORY.md (~/proj/MEMORY.md) >>>',
      '',
      'Database: SQLite via sql.js.',
      '',
      'Auth: OAuth flow uses bouncer endpoint.',
    ].join('\n'),
    sources: [],
    truncatedBytes: 0,
  };

  it('returns a stub when bundle is empty', () => {
    expect(
      recallFromBundle({ text: '', sources: [], truncatedBytes: 0 }, 'foo')
    ).toMatch(/no memory loaded/);
  });

  it('returns a stub when query is empty/whitespace', () => {
    expect(recallFromBundle(bundle, '   ')).toMatch(/no memory loaded/);
  });

  it('finds substring matches case-insensitively', () => {
    const r = recallFromBundle(bundle, 'TypeScript');
    expect(r).toContain('Guidance: prefer TypeScript');
  });

  it('includes the source header for each match', () => {
    const r = recallFromBundle(bundle, 'sqlite');
    expect(r).toContain('<<< MEMORY.md');
    expect(r).toContain('Database: SQLite');
  });

  it('returns "no matches" stub when query has no hits', () => {
    expect(recallFromBundle(bundle, 'totally-not-there')).toMatch(/no matches/);
  });

  it('separates multiple matches with horizontal rules', () => {
    const r = recallFromBundle(bundle, 'a'); // matches many paragraphs
    expect(r.split('---').length).toBeGreaterThan(1);
  });

  it('caps the number of matches at maxResults', () => {
    const r = recallFromBundle(bundle, 'e', 1); // matches everything
    // At most 1 match → no separator.
    expect(r.split('---').length).toBe(1);
  });
});
