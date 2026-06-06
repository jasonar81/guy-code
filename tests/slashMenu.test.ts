/**
 * Tests for `src/lib/slashMenu.ts` — the pure helpers that drive the
 * slash-command autocomplete UI in the Composer.
 *
 * Coverage targets:
 *   • detectSlashContext mirrors the backend `parseSlashCommand` rules
 *     (so the menu only appears when the agent will actually fire the
 *     command on submit).
 *   • filterSkills ranks tier-0 (prefix on name) before tier-1
 *     (substring on name) before tier-2 (substring on description),
 *     and within each tier sorts alphabetically.
 *   • applySkillPick splices the chosen skill in place without
 *     disturbing surrounding text, and the new cursor position lands
 *     immediately after the trailing space.
 *
 * No DOM, no React, no timers. These helpers are pure functions of
 * (text, cursor, skill list).
 */
import { describe, expect, it } from 'vitest';
import {
  detectSlashContext,
  filterSkills,
  applySkillPick,
} from '../src/lib/slashMenu';
import type { SkillSummary } from '../src/types';

function fakeSkill(
  name: string,
  description = `desc for ${name}`,
  source: SkillSummary['source'] = 'guy-user'
): SkillSummary {
  return { name, description, source };
}

// ---- detectSlashContext -----------------------------------------------

describe('detectSlashContext', () => {
  it('returns null for empty input', () => {
    expect(detectSlashContext('', 0)).toBeNull();
  });

  it('returns null when text does not start with /', () => {
    expect(detectSlashContext('hello /foo', 8)).toBeNull();
    expect(detectSlashContext('hello', 5)).toBeNull();
  });

  it('opens the menu (empty query) for a bare leading slash — the picker UX', () => {
    // Typing just `/` is how the user browses the full alphabetical list
    // when they can't remember a skill name. It must yield a context with an
    // empty query (filterSkills('') then returns the full sorted list).
    const r = detectSlashContext('/', 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe('');
    expect(r!.slashStart).toBe(0);
    expect(r!.queryEnd).toBe(1);
  });

  it('opens the menu for a bare slash after leading whitespace', () => {
    const r = detectSlashContext('  /', 3);
    expect(r).not.toBeNull();
    expect(r!.query).toBe('');
    expect(r!.slashStart).toBe(2);
  });

  it('still rejects // (comment-ish) and "/ " (slash then space)', () => {
    expect(detectSlashContext('//', 2)).toBeNull();
    expect(detectSlashContext('/ ', 1)).toBeNull();
  });

  it('detects /foo with cursor at the end of foo', () => {
    const r = detectSlashContext('/foo', 4);
    expect(r).not.toBeNull();
    expect(r!.query).toBe('foo');
    expect(r!.slashStart).toBe(0);
    expect(r!.queryEnd).toBe(4);
  });

  it('detects /foo with cursor in the middle of the query', () => {
    const r = detectSlashContext('/foo', 2);
    expect(r).not.toBeNull();
    expect(r!.query).toBe('f'); // query is text BEFORE the cursor
    expect(r!.queryEnd).toBe(4); // end of word, regardless of cursor
  });

  it('detects /foo right after the leading slash (cursor at 1)', () => {
    const r = detectSlashContext('/foo', 1);
    expect(r).not.toBeNull();
    expect(r!.query).toBe('');
  });

  it('returns null after the user types a space (cursor past the word)', () => {
    // "/foo " with cursor at position 5 (after the space) → menu hides.
    expect(detectSlashContext('/foo ', 5)).toBeNull();
  });

  it('returns context while cursor is BEFORE the second slash, null after', () => {
    // The user is mid-typing — `/path` could still become `/path-tool`,
    // so we keep the menu visible. queryEnd extends to end-of-text since
    // there's no whitespace terminator yet.
    const r = detectSlashContext('/path/like/this', 4);
    expect(r).not.toBeNull();
    expect(r!.query).toBe('pat');
    expect(r!.slashStart).toBe(0);
    // ...but the moment the cursor crosses past the second slash, the
    // query slice contains a `/` and we hide the menu — clearly a path,
    // not a skill name.
    expect(detectSlashContext('/path/like/this', 8)).toBeNull();
  });

  it('returns null for // and / followed by space (matches parser)', () => {
    expect(detectSlashContext('//', 2)).toBeNull();
    expect(detectSlashContext('/ thing', 7)).toBeNull();
  });

  it('tolerates leading whitespace before the slash', () => {
    const r = detectSlashContext('  /foo', 6);
    expect(r).not.toBeNull();
    expect(r!.query).toBe('foo');
    expect(r!.slashStart).toBe(2);
    expect(r!.queryEnd).toBe(6);
  });

  it('returns null when cursor is BEFORE the slash', () => {
    expect(detectSlashContext('/foo', 0)).toBeNull();
  });

  it('returns null when cursor is past the end of the command name', () => {
    // " /foo extra" → cursor at 11 (end of "extra") is past the
    // command name, menu hides.
    expect(detectSlashContext('/foo extra', 10)).toBeNull();
  });
});

// ---- filterSkills -----------------------------------------------------

describe('filterSkills', () => {
  const skills = [
    fakeSkill('feature-spec', 'write a product feature spec'),
    fakeSkill('feature-flags', 'manage feature flags'),
    fakeSkill('engineering-design', 'engineering design doc'),
    fakeSkill('reviewing-prs', 'review pull requests'),
    fakeSkill('zzz-feature-cleanup', 'cleanup of feature branches'),
  ];

  it('returns the full list (alphabetical) when query is empty', () => {
    const r = filterSkills(skills, '');
    expect(r.map((s) => s.name)).toEqual([
      'engineering-design',
      'feature-flags',
      'feature-spec',
      'reviewing-prs',
      'zzz-feature-cleanup',
    ]);
  });

  it('prefix matches outrank substring matches on name', () => {
    const r = filterSkills(skills, 'feat');
    // tier 0 (prefix): feature-flags, feature-spec
    // tier 1 (substring): zzz-feature-cleanup
    // tier 2 (description): engineering-design? no, no "feat" in desc.
    //   Actually `feature-flags`, `feature-spec`, and `zzz-feature-cleanup`
    //   all have "feature" in their descriptions, but they're already
    //   captured in higher tiers.
    expect(r[0].name).toBe('feature-flags');
    expect(r[1].name).toBe('feature-spec');
    expect(r[2].name).toBe('zzz-feature-cleanup');
  });

  it('falls back to description match when name does not contain the query', () => {
    const r = filterSkills(skills, 'product');
    expect(r.map((s) => s.name)).toEqual(['feature-spec']);
  });

  it('matches case-insensitively', () => {
    const r = filterSkills(skills, 'FEAT');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].name).toBe('feature-flags');
  });

  it('returns an empty array when nothing matches', () => {
    const r = filterSkills(skills, 'xyzzy-no-match');
    expect(r).toEqual([]);
  });

  it('respects the limit parameter', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      fakeSkill(`skill-${String(i).padStart(2, '0')}`)
    );
    const r = filterSkills(many, '', 10);
    expect(r).toHaveLength(10);
  });

  it('within a tier, sorts alphabetically by name', () => {
    const odd = [
      fakeSkill('beta-alpha'),
      fakeSkill('alpha-beta'),
      fakeSkill('gamma-alpha'),
    ];
    // All have "alpha" in their names; tier-1 substring matches.
    // The first one ('beta-alpha') has 'alpha' as a substring, so it
    // would be tier-1; 'alpha-beta' starts with 'alpha' → tier-0;
    // 'gamma-alpha' is tier-1.
    const r = filterSkills(odd, 'alpha');
    expect(r[0].name).toBe('alpha-beta'); // tier-0 prefix
    // tier-1 results sorted alphabetically:
    expect(r[1].name).toBe('beta-alpha');
    expect(r[2].name).toBe('gamma-alpha');
  });
});

// ---- applySkillPick ---------------------------------------------------

describe('applySkillPick', () => {
  it('replaces the partial command with the chosen full name + space', () => {
    const text = '/feat';
    const ctx = detectSlashContext(text, text.length)!;
    const r = applySkillPick(text, ctx, 'feature-spec');
    expect(r.newText).toBe('/feature-spec ');
    expect(r.newCursor).toBe('/feature-spec '.length); // == 14
  });

  it('preserves leading whitespace before the slash', () => {
    const text = '  /feat';
    const ctx = detectSlashContext(text, text.length)!;
    const r = applySkillPick(text, ctx, 'feature-spec');
    expect(r.newText).toBe('  /feature-spec ');
    expect(r.newCursor).toBe('  /feature-spec '.length);
  });

  it('preserves trailing args after the partial command', () => {
    // User typed `/feat extra args`, then went back and is selecting a
    // skill at cursor position 5 (end of `feat`). We should splice
    // ONLY the command name, leaving `extra args` intact.
    const text = '/feat extra args';
    const ctx = detectSlashContext(text, 5)!;
    const r = applySkillPick(text, ctx, 'feature-spec');
    expect(r.newText).toBe('/feature-spec  extra args');
    // Cursor lands right after the inserted skill name + space, which
    // is right before the user's original space.
    expect(r.newCursor).toBe('/feature-spec '.length);
  });

  it('handles cursor mid-query correctly', () => {
    // User typed `/fe`, decided to pick from menu. Cursor is at 3.
    // `queryEnd` should still be at the end of the word (3, since
    // there's no more text), so the splice replaces `/fe` exactly.
    const text = '/fe';
    const ctx = detectSlashContext(text, 3)!;
    const r = applySkillPick(text, ctx, 'feature-spec');
    expect(r.newText).toBe('/feature-spec ');
  });
});
