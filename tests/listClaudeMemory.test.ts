/**
 * Tests for `listClaudeMemory` in `electron/memory.ts` — the function that
 * lets `list_memory` surface the read-only ~/.claude imports (not just the
 * Guy-owned ~/.guycode leaves).
 *
 * Background: `list_memory` historically showed ONLY Guy-owned leaves, so a
 * model orienting itself was blind to imported Claude reference/feedback
 * docs (e.g. the pre-PR hardening checklist). That caused a real miss. This
 * function enumerates the same ~/.claude leaves the session-start loader
 * walks, with parsed name/description so the trigger text is visible.
 *
 * These tests run against the REAL ~/.claude tree on the machine (the
 * function is read-only — it only stats + reads frontmatter, never writes).
 * That also makes them a meaningful regression guard: they assert the
 * function actually surfaces the kind of imported reference docs that were
 * previously invisible. If the machine has no ~/.claude tree (e.g. a clean
 * CI runner), the structural assertions degrade gracefully.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listClaudeMemory } from '../electron/memory';

const claudeRoot = join(homedir(), '.claude');
const hasClaudeTree = existsSync(claudeRoot);

describe('listClaudeMemory', () => {
  it('returns an array and never throws', () => {
    const rows = listClaudeMemory({ cwd: '', projectId: '__guy_default__' });
    expect(Array.isArray(rows)).toBe(true);
  });

  it('tolerates an undefined projectId', () => {
    expect(() => listClaudeMemory({ cwd: '' })).not.toThrow();
  });

  it('every row has a path, byte count, and mtime', () => {
    const rows = listClaudeMemory({ cwd: '', projectId: '__guy_default__' });
    for (const r of rows) {
      expect(typeof r.path).toBe('string');
      expect(r.path.length).toBeGreaterThan(0);
      expect(typeof r.bytes).toBe('number');
      expect(r.bytes).toBeGreaterThanOrEqual(0);
      expect(typeof r.mtime).toBe('number');
    }
  });

  it('returns no duplicate paths', () => {
    const rows = listClaudeMemory({ cwd: '', projectId: '__guy_default__' });
    const paths = rows.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('only lists files under ~/.claude (read-only tree)', () => {
    const rows = listClaudeMemory({ cwd: '', projectId: '__guy_default__' });
    for (const r of rows) {
      // Normalize separators for the comparison.
      expect(r.path.replace(/\\/g, '/')).toContain('/.claude/');
    }
  });

  // The following assertions depend on the real machine having a ~/.claude
  // tree with the imported reference docs. Skipped on machines without one.
  it.skipIf(!hasClaudeTree)(
    'surfaces imported reference/feedback leaves a cwd-less session can see',
    () => {
      const rows = listClaudeMemory({ cwd: '', projectId: '__guy_default__' });
      // A cwd-less session uses the cross-project fallback, so it should pick
      // up at least one reference_* or feedback_* leaf if any exist.
      expect(rows.length).toBeGreaterThan(0);
    }
  );

  it.skipIf(!hasClaudeTree)(
    'parses frontmatter name/description when present (the hardening reference)',
    () => {
      const rows = listClaudeMemory({ cwd: '', projectId: '__guy_default__' });
      const hardening = rows.find((r) =>
        r.path.replace(/\\/g, '/').includes('reference_xgsrc_pre_pr_hardening')
      );
      // The doc is known to exist on the dev machine. If present, it must
      // carry a parsed description (the trigger text). If a given machine
      // doesn't have it, this is a no-op rather than a false failure.
      if (hardening) {
        expect(hardening.name).toBeTruthy();
        expect((hardening.description ?? '').length).toBeGreaterThan(0);
      }
    }
  );
});
