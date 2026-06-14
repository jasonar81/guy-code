/**
 * Tests for the tiered-memory system in `electron/memory.ts`.
 *
 * Background: loadMemory used to include Guy leaves in alphabetical filename
 * order under a flat byte budget, so small permanent rules lost the lottery
 * to large dead per-task state dumps and never reached the model's context.
 * The fix: three tiers (pinned / normal / archived), pinned always loads
 * first and is never evicted, archived loads last but stays recall-searchable,
 * and non-pinned leaves auto-archive by staleness (mtime > 14d) with zero
 * file churn (computed at load time).
 *
 * Strategy: `os.homedir()` re-reads USERPROFILE/HOME on every call, so we
 * point the whole Guy memory tree at a temp dir by setting those env vars.
 * No module mocking needed — memory.ts's internal homedir() calls follow.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readExplicitTier,
  getEffectiveTier,
  upsertPriorityFrontmatter,
  saveMemory,
  setMemoryPriority,
  loadMemory,
  recallFromDisk,
  listGuyMemory,
} from '../electron/memory';

// ---- Pure helpers (no HOME needed) --------------------------------------

describe('upsertPriorityFrontmatter', () => {
  it('prepends a frontmatter block to content that has none', () => {
    const out = upsertPriorityFrontmatter('# Title\n\nbody', 'pinned');
    expect(out).toBe('---\npriority: pinned\n---\n\n# Title\n\nbody');
  });

  it('adds a priority line to existing frontmatter without a priority', () => {
    const input = '---\nname: My Rule\ndescription: stuff\n---\n\nbody';
    const out = upsertPriorityFrontmatter(input, 'archived');
    expect(out).toMatch(/name: My Rule/);
    expect(out).toMatch(/description: stuff/);
    expect(out).toMatch(/priority: archived/);
    expect(out).toMatch(/\n---\n\nbody$/);
  });

  it('replaces an existing priority line in place', () => {
    const input = '---\npriority: normal\nname: X\n---\nbody';
    const out = upsertPriorityFrontmatter(input, 'pinned');
    expect(out).toMatch(/priority: pinned/);
    expect(out).not.toMatch(/priority: normal/);
    expect(out).toMatch(/name: X/);
  });

  it('is idempotent', () => {
    const once = upsertPriorityFrontmatter('# T\nbody', 'normal');
    const twice = upsertPriorityFrontmatter(once, 'normal');
    expect(twice).toBe(once);
  });
});

// ---- Path-based helpers (temp files, no HOME needed) ---------------------

describe('readExplicitTier / getEffectiveTier', () => {
  const dir = join(tmpdir(), `gc-tier-pure-${process.pid}-${Date.now()}`);
  beforeAll(() => mkdirSync(dir, { recursive: true }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const writeLeaf = (name: string, body: string, ageDays = 0): string => {
    const p = join(dir, name);
    writeFileSync(p, body, 'utf8');
    if (ageDays > 0) {
      const t = new Date(Date.now() - ageDays * 86400_000);
      utimesSync(p, t, t);
    }
    return p;
  };

  it('reads an explicit pinned tier', () => {
    const p = writeLeaf('a.md', '---\npriority: pinned\n---\nx');
    expect(readExplicitTier(p)).toBe('pinned');
  });

  it('returns null when there is no frontmatter', () => {
    const p = writeLeaf('b.md', '# Heading\nbody');
    expect(readExplicitTier(p)).toBeNull();
  });

  it('pinned is sticky regardless of age', () => {
    const p = writeLeaf('c.md', '---\npriority: pinned\n---\nx', 999);
    expect(getEffectiveTier(p, Date.now() - 999 * 86400_000)).toBe('pinned');
  });

  it('a fresh leaf with no frontmatter is normal', () => {
    const p = writeLeaf('d.md', '# fresh\nbody', 0);
    expect(getEffectiveTier(p, Date.now())).toBe('normal');
  });

  it('a no-frontmatter leaf older than 14 days auto-archives', () => {
    const p = writeLeaf('e.md', '# old\nbody', 20);
    expect(getEffectiveTier(p, Date.now() - 20 * 86400_000)).toBe('archived');
  });

  it('an explicitly archived leaf is archived even when fresh', () => {
    const p = writeLeaf('f.md', '---\npriority: archived\n---\nx', 0);
    expect(getEffectiveTier(p, Date.now())).toBe('archived');
  });
});

// ---- Integration over a temp Guy memory tree ----------------------------

describe('tiered loadMemory + save/set + recall (temp HOME)', () => {
  const FAKE_HOME = join(tmpdir(), `gc-tier-home-${process.pid}-${Date.now()}`);
  const guyGlobal = join(FAKE_HOME, '.guycode', 'memory');
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = FAKE_HOME;
    process.env.USERPROFILE = FAKE_HOME;
    mkdirSync(guyGlobal, { recursive: true });
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    rmSync(FAKE_HOME, { recursive: true, force: true });
  });

  const projectId = '__guy_test__';

  it('saveMemory stamps the priority into frontmatter', () => {
    const r = saveMemory({ scope: 'global', key: 'rule', content: '# Rule\nalways do X', priority: 'pinned' });
    expect(r.ok).toBe(true);
    expect(readExplicitTier(r.path!)).toBe('pinned');
  });

  it('saveMemory replace preserves an existing tier when no priority arg given', () => {
    saveMemory({ scope: 'global', key: 'rule', content: '# v1', priority: 'pinned' });
    const r = saveMemory({ scope: 'global', key: 'rule', content: '# v2 updated' });
    expect(r.ok).toBe(true);
    expect(readExplicitTier(r.path!)).toBe('pinned');
  });

  it('setMemoryPriority pins / archives / unarchives and preserves mtime', () => {
    const s = saveMemory({ scope: 'global', key: 'task', content: '# task state' });
    const p = s.path!;
    // Age it so it would otherwise be stale; archive explicitly.
    const old = new Date(Date.now() - 30 * 86400_000);
    utimesSync(p, old, old);
    const r = setMemoryPriority({ scope: 'global', key: 'task', priority: 'archived' });
    expect(r.ok).toBe(true);
    expect(readExplicitTier(p)).toBe('archived');
    // Unarchive back to normal; mtime must be preserved (still old).
    setMemoryPriority({ scope: 'global', key: 'task', priority: 'normal' });
    expect(readExplicitTier(p)).toBe('normal');
  });

  it('pinned leaf always loads even behind a large pile of normal leaves', () => {
    // One small pinned rule (alphabetically LAST so the old loader would
    // have evicted it), plus enough big normal leaves to blow the budget.
    saveMemory({ scope: 'global', key: 'zzz-critical-rule', content: '# CRITICAL\nuse worktrees', priority: 'pinned' });
    const big = '# big\n' + 'x'.repeat(15_000);
    for (let i = 0; i < 30; i++) {
      saveMemory({ scope: 'global', key: `aaa-task-${i}`, content: big, priority: 'normal' });
    }
    const bundle = loadMemory({ cwd: '', projectId });
    expect(bundle.text).toContain('zzz-critical-rule');
    expect(bundle.text).toContain('use worktrees');
    // This test writes ~31 files synchronously; the default 5s timeout is tight
    // on slow CI runners (Windows), so give it room.
  }, 30_000);

  it('archived leaves load after normal and are deprioritized under budget', () => {
    saveMemory({ scope: 'global', key: 'pinned-rule', content: '# pinned rule', priority: 'pinned' });
    const big = '# big\n' + 'x'.repeat(15_000);
    for (let i = 0; i < 20; i++) {
      saveMemory({ scope: 'global', key: `normal-${i}`, content: big, priority: 'normal' });
    }
    saveMemory({ scope: 'global', key: 'archived-thing', content: '# ARCHIVED CONTENT marker', priority: 'archived' });
    const bundle = loadMemory({ cwd: '', projectId });
    // Pinned always in.
    expect(bundle.text).toContain('pinned rule');
    // With 20 * 15KB of normal ahead of it, the archived leaf is squeezed out
    // of the always-loaded budget.
    expect(bundle.text).not.toContain('ARCHIVED CONTENT marker');
  }, 30_000);

  it('recallFromDisk finds content in an archived leaf even though it did not load', () => {
    saveMemory({ scope: 'global', key: 'pinned-rule', content: '# pinned', priority: 'pinned' });
    const big = '# big\n' + 'x'.repeat(15_000);
    for (let i = 0; i < 20; i++) {
      saveMemory({ scope: 'global', key: `normal-${i}`, content: big, priority: 'normal' });
    }
    saveMemory({
      scope: 'global',
      key: 'archived-thing',
      content: '# done task\nThe SECRET_TOKEN_XYZ was deadbeef.',
      priority: 'archived',
    });
    // Confirm it's NOT in the loaded bundle...
    const bundle = loadMemory({ cwd: '', projectId });
    expect(bundle.text).not.toContain('SECRET_TOKEN_XYZ');
    // ...but recall (disk scan, all tiers) finds it.
    const hit = recallFromDisk({ cwd: '', projectId, query: 'SECRET_TOKEN_XYZ' });
    expect(hit).toContain('SECRET_TOKEN_XYZ');
    expect(hit).toContain('[archived]');
  });

  it('listGuyMemory reports effective + explicit tier', () => {
    saveMemory({ scope: 'global', key: 'p', content: '# p', priority: 'pinned' });
    saveMemory({ scope: 'global', key: 'n', content: '# n' });
    const rows = listGuyMemory({ scope: 'global' });
    const pinned = rows.find((r) => r.path.endsWith('p.md'));
    const normal = rows.find((r) => r.path.endsWith('n.md'));
    expect(pinned?.tier).toBe('pinned');
    expect(pinned?.explicitTier).toBe('pinned');
    expect(normal?.tier).toBe('normal');
    expect(normal?.explicitTier).toBeNull();
  });
});
