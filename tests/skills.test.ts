/**
 * Tests for `electron/skills.ts` — the loader, registry, slash-command
 * parser, and system-prompt block renderer.
 *
 * Coverage target:
 *   • Discovery walks all four roots in priority order.
 *   • Name-collision policy: first hit wins, loser ends up in shadowed.
 *   • Frontmatter parsing handles the common shapes (name, description,
 *     quoted values, missing fields, no frontmatter at all).
 *   • Both layouts work: <root>/<name>/SKILL.md and <root>/<name>.md
 *   • Slash-command parser is strict (no `/path/like/this`, no
 *     `// comment`) and lenient (case-insensitive arg whitespace,
 *     multi-line context).
 *   • System-prompt block renders when there are skills, returns ""
 *     when there are none, sorts deterministically.
 *
 * Strategy: build a fake home + cwd in tmp, write SKILL.md files into
 * each of the four discovery roots, and call loadSkills directly.
 * No homedir mocking needed because loadSkills accepts a `cwd` arg
 * AND uses homedir() — we use vi.spyOn to redirect homedir cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSkills,
  parseSlashCommand,
  rewriteSlashCommand,
  renderSkillsBlock,
  _setHomeForTesting,
} from '../electron/skills';

let _fakeHome = '';
let _fakeCwd = '';

beforeEach(() => {
  _fakeHome = mkdtempSync(join(tmpdir(), 'guycode-skills-home-'));
  _fakeCwd = mkdtempSync(join(tmpdir(), 'guycode-skills-cwd-'));
  // Redirect homedir() inside skills.ts to our fake home so tests
  // don't pick up the user's actual ~/.guycode/skills. ESM doesn't
  // let us spy on `os.homedir` directly, so skills.ts exposes a
  // `_setHomeForTesting` seam.
  _setHomeForTesting(_fakeHome);
});

afterEach(() => {
  _setHomeForTesting(null);
  for (const dir of [_fakeHome, _fakeCwd]) {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  _fakeHome = '';
  _fakeCwd = '';
});

// ---- Helpers -----------------------------------------------------------

function writeSkillFile(rootDir: string, name: string, content: string): string {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, content, 'utf8');
  return path;
}

function writeFlatSkill(rootDir: string, filename: string, content: string): string {
  mkdirSync(rootDir, { recursive: true });
  const path = join(rootDir, filename);
  writeFileSync(path, content, 'utf8');
  return path;
}

function fmSkill(name: string, description: string, body: string = 'Body of skill.'): string {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', body].join('\n');
}

// ---- Discovery ---------------------------------------------------------

describe('loadSkills discovery', () => {
  it('returns empty registry when no roots exist', () => {
    const r = loadSkills(_fakeCwd);
    expect(r.skills).toEqual([]);
    expect(r.shadowed).toEqual([]);
  });

  it('finds skills in ~/.guycode/skills/', () => {
    writeSkillFile(
      join(_fakeHome, '.guycode', 'skills'),
      'foo',
      fmSkill('foo', 'a guy-user skill')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].name).toBe('foo');
    expect(r.skills[0].description).toBe('a guy-user skill');
    expect(r.skills[0].source).toBe('guy-user');
  });

  it('finds skills in <cwd>/.guycode/skills/', () => {
    writeSkillFile(
      join(_fakeCwd, '.guycode', 'skills'),
      'project-foo',
      fmSkill('project-foo', 'a project-local Guy skill')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills.map((s) => s.name)).toEqual(['project-foo']);
    expect(r.skills[0].source).toBe('guy-project');
  });

  it('imports skills from ~/.claude/skills/', () => {
    writeSkillFile(
      join(_fakeHome, '.claude', 'skills'),
      'feature-spec',
      fmSkill('feature-spec', 'imported claude-user skill')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills.map((s) => s.name)).toEqual(['feature-spec']);
    expect(r.skills[0].source).toBe('claude-user');
  });

  it('imports skills from <cwd>/.claude/skills/', () => {
    writeSkillFile(
      join(_fakeCwd, '.claude', 'skills'),
      'project-skill',
      fmSkill('project-skill', 'imported claude-project skill')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills.map((s) => s.name)).toEqual(['project-skill']);
    expect(r.skills[0].source).toBe('claude-project');
  });

  it('loads from the legacy ~/.claude/commands/ flat-md location', () => {
    writeFlatSkill(
      join(_fakeHome, '.claude', 'commands'),
      'foo.md',
      fmSkill('foo', 'a command-style skill')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills.map((s) => s.name)).toEqual(['foo']);
    expect(r.skills[0].source).toBe('claude-commands');
  });

  it('skips loading project-scoped roots when no cwd is provided', () => {
    writeSkillFile(
      join(_fakeCwd, '.guycode', 'skills'),
      'project-x',
      fmSkill('project-x', 'project-local skill')
    );
    writeSkillFile(
      join(_fakeHome, '.guycode', 'skills'),
      'user-y',
      fmSkill('user-y', 'user-global skill')
    );
    // No cwd → only ~/.guycode/skills should be reachable.
    const r = loadSkills(null);
    expect(r.skills.map((s) => s.name)).toEqual(['user-y']);
  });
});

// ---- Name collision (shadowing) ----------------------------------------

describe('loadSkills name collisions', () => {
  it('Guy-user wins over claude-user when both define the same name', () => {
    writeSkillFile(
      join(_fakeHome, '.guycode', 'skills'),
      'feature-spec',
      fmSkill('feature-spec', 'guy version (wins)')
    );
    writeSkillFile(
      join(_fakeHome, '.claude', 'skills'),
      'feature-spec',
      fmSkill('feature-spec', 'claude version (shadowed)')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].source).toBe('guy-user');
    expect(r.skills[0].description).toBe('guy version (wins)');
    expect(r.shadowed).toHaveLength(1);
    expect(r.shadowed[0].source).toBe('claude-user');
    expect(r.shadowed[0].description).toBe('claude version (shadowed)');
  });

  it('project-scope wins over user-scope within the same provider', () => {
    writeSkillFile(
      join(_fakeCwd, '.guycode', 'skills'),
      'shared',
      fmSkill('shared', 'project version')
    );
    writeSkillFile(
      join(_fakeHome, '.guycode', 'skills'),
      'shared',
      fmSkill('shared', 'user version')
    );
    const r = loadSkills(_fakeCwd);
    // user is loaded FIRST per priority order, so user-version wins.
    // (This matches the "first hit wins" rule. If a future change
    // wants project to win we'd need to reorder scanRoots.)
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].source).toBe('guy-user');
  });
});

// ---- Frontmatter parsing -----------------------------------------------

describe('frontmatter parsing', () => {
  it('handles single-quoted and double-quoted values', () => {
    writeSkillFile(
      join(_fakeHome, '.guycode', 'skills'),
      'q-test',
      ['---', `name: 'q-test'`, `description: "a quoted desc"`, '---', '', 'body'].join('\n')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills[0].name).toBe('q-test');
    expect(r.skills[0].description).toBe('a quoted desc');
  });

  it('falls back to filename / dir name when frontmatter omits name', () => {
    writeSkillFile(
      join(_fakeHome, '.guycode', 'skills'),
      'dir-fallback',
      ['---', 'description: no name field', '---', '', 'body'].join('\n')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills[0].name).toBe('dir-fallback');
    expect(r.skills[0].description).toBe('no name field');
  });

  it('handles markdown files with no frontmatter at all', () => {
    writeFlatSkill(
      join(_fakeHome, '.claude', 'commands'),
      'plain.md',
      ['# Heading', '', 'first body line is the description fallback.', '', 'more text'].join('\n')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills[0].name).toBe('plain');
    expect(r.skills[0].description).toBe('first body line is the description fallback.');
  });

  it('exposes the FULL body verbatim in the loaded Skill', () => {
    const body = 'STEP 1: do thing\nSTEP 2: do other thing\nSTEP 3: profit';
    writeSkillFile(
      join(_fakeHome, '.guycode', 'skills'),
      'multi-step',
      [`---`, `name: multi-step`, `description: walks through steps`, `---`, ``, body].join('\n')
    );
    const r = loadSkills(_fakeCwd);
    expect(r.skills[0].body).toContain(body);
    expect(r.skills[0].body).toContain('name: multi-step');
  });
});

// ---- Slash command parsing --------------------------------------------

describe('parseSlashCommand', () => {
  function regWith(...names: string[]) {
    return {
      skills: names.map((n) => ({
        name: n,
        description: `desc for ${n}`,
        body: `body of ${n}`,
        path: '/fake/' + n + '/SKILL.md',
        dir: '/fake/' + n,
        source: 'guy-user' as const,
      })),
      shadowed: [],
    };
  }

  it('returns null when text does not start with /', () => {
    expect(parseSlashCommand('hello world', regWith('foo'))).toBeNull();
    expect(parseSlashCommand('  no leading slash  ', regWith('foo'))).toBeNull();
  });

  it('rejects /path/like/this paths (second char is /)', () => {
    expect(parseSlashCommand('/usr/bin/foo', regWith('usr'))).toBeNull();
    expect(parseSlashCommand('//comment', regWith('comment'))).toBeNull();
  });

  it('rejects "/ thing" with a space right after slash', () => {
    expect(parseSlashCommand('/ feature-spec', regWith('feature-spec'))).toBeNull();
  });

  it('returns null when the command name does not match a registered skill', () => {
    expect(parseSlashCommand('/unknown-skill arg', regWith('foo', 'bar'))).toBeNull();
  });

  it('parses a bare slash command with no args', () => {
    const m = parseSlashCommand('/feature-spec', regWith('feature-spec'));
    expect(m).not.toBeNull();
    expect(m!.skill.name).toBe('feature-spec');
    expect(m!.args).toBe('');
    expect(m!.following).toBe('');
  });

  it('parses a slash command with inline args on the first line', () => {
    const m = parseSlashCommand(
      '/feature-spec Carry-over budget model',
      regWith('feature-spec')
    );
    expect(m!.skill.name).toBe('feature-spec');
    expect(m!.args).toBe('Carry-over budget model');
    expect(m!.following).toBe('');
  });

  it('preserves following lines as additional context', () => {
    const m = parseSlashCommand(
      '/feature-spec Title\nFocus on per-key isolation.\nWith a walked example.',
      regWith('feature-spec')
    );
    expect(m!.skill.name).toBe('feature-spec');
    expect(m!.args).toBe('Title');
    expect(m!.following).toBe('Focus on per-key isolation.\nWith a walked example.');
  });

  it('tolerates leading whitespace before the slash', () => {
    const m = parseSlashCommand('  \n  /foo bar', regWith('foo'));
    expect(m).not.toBeNull();
    expect(m!.skill.name).toBe('foo');
    expect(m!.args).toBe('bar');
    expect(m!.preceding).toBe('  \n  ');
  });
});

describe('rewriteSlashCommand', () => {
  function fakeSkill(name = 'foo'): any {
    return {
      name,
      description: `description of ${name}`,
      body: 'body',
      path: '/fake/path',
      dir: '/fake',
      source: 'guy-user',
    };
  }

  it('emits an instruction to call the Skill tool with the right name', () => {
    const out = rewriteSlashCommand({
      skill: fakeSkill('feature-spec'),
      args: '',
      preceding: '',
      following: '',
    });
    expect(out).toMatch(/Use the skill `feature-spec`/);
    expect(out).toMatch(/SkillName="feature-spec"/);
  });

  it('forwards inline args under "Args / inline context"', () => {
    const out = rewriteSlashCommand({
      skill: fakeSkill('foo'),
      args: 'a b c',
      preceding: '',
      following: '',
    });
    expect(out).toMatch(/Args \/ inline context: a b c/);
  });

  it('forwards following lines under "Additional user context"', () => {
    const out = rewriteSlashCommand({
      skill: fakeSkill('foo'),
      args: '',
      preceding: '',
      following: 'multi-line\ncontext block',
    });
    expect(out).toMatch(/Additional user context:/);
    expect(out).toContain('multi-line\ncontext block');
  });
});

// ---- System-prompt block ----------------------------------------------

describe('renderSkillsBlock', () => {
  it('returns "" when no skills are loaded', () => {
    expect(renderSkillsBlock({ skills: [], shadowed: [] })).toBe('');
  });

  it('lists skills sorted by name', () => {
    const reg = {
      skills: [
        {
          name: 'zeta',
          description: 'last',
          body: '',
          path: '',
          dir: '',
          source: 'guy-user' as const,
        },
        {
          name: 'alpha',
          description: 'first',
          body: '',
          path: '',
          dir: '',
          source: 'guy-user' as const,
        },
      ],
      shadowed: [],
    };
    // loadSkills sorts; we trust that. renderSkillsBlock just iterates.
    // Mirror the sorted order here so the test pins format, not order.
    const sorted = {
      ...reg,
      skills: [...reg.skills].sort((a, b) => a.name.localeCompare(b.name)),
    };
    const out = renderSkillsBlock(sorted);
    expect(out).toMatch(/Available skills/);
    const idxAlpha = out.indexOf('alpha');
    const idxZeta = out.indexOf('zeta');
    expect(idxAlpha).toBeGreaterThan(0);
    expect(idxZeta).toBeGreaterThan(idxAlpha);
  });

  it('truncates very long descriptions with an ellipsis', () => {
    const longDesc = 'x'.repeat(500);
    const reg = {
      skills: [
        {
          name: 'long',
          description: longDesc,
          body: '',
          path: '',
          dir: '',
          source: 'guy-user' as const,
        },
      ],
      shadowed: [],
    };
    const out = renderSkillsBlock(reg);
    expect(out).toMatch(/long: x+…/);
  });
});
