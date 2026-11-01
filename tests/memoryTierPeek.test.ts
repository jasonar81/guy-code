/**
 * Working out a memory leaf's tier must not read the whole file.
 *
 * Every uncached memory load ranks all Guy-owned leaves by tier, and the
 * tier lives in each leaf's frontmatter. It used to be found by reading
 * EVERY leaf in full: on a real tree that was 1,312 full file reads,
 * 18.9 MB, per load. On an idle disk that is ~150ms; with several sessions
 * streaming and running tools it measured 30-58 SECONDS of blocked main
 * process, which is the "Not Responding" that came with streaming.
 *
 * Now it reads only the first few KB of a leaf, and caches the answer
 * against the file's mtime so an unchanged leaf is never opened twice.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0' }, safeStorage: {} }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tierpeek-'));
});

function leaf(name: string, body: string, mtimeSec?: number): { path: string; mtimeMs: number } {
  const p = join(dir, name);
  writeFileSync(p, body, 'utf8');
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return { path: p, mtimeMs: statSync(p).mtimeMs };
}

describe('readExplicitTier', () => {
  it('reads the tier from frontmatter', async () => {
    const { readExplicitTier } = await import('../electron/memory');
    expect(readExplicitTier(leaf('a.md', '---\npriority: pinned\n---\nbody').path)).toBe('pinned');
    expect(readExplicitTier(leaf('b.md', '---\npriority: archived\n---\nbody').path)).toBe('archived');
    expect(readExplicitTier(leaf('c.md', 'no frontmatter here').path)).toBeNull();
  });

  it('finds the tier in a HUGE leaf without needing the rest of it', async () => {
    const { readExplicitTier } = await import('../electron/memory');
    // 5 MB of body after the frontmatter - the head is all that matters.
    const big = '---\npriority: pinned\n---\n' + 'x'.repeat(5 * 1024 * 1024);
    expect(readExplicitTier(leaf('big.md', big).path)).toBe('pinned');
  });

  it('serves an unchanged leaf from the cache without opening it again', async () => {
    const mem = await import('../electron/memory');
    const fs = await import('node:fs');
    const { path, mtimeMs } = leaf('c1.md', '---\npriority: pinned\n---\nbody', 1_700_000_000);
    expect(mem.readExplicitTier(path, mtimeMs)).toBe('pinned');
    // Replace the file's CONTENT but restore the same mtime: a cache hit must
    // not notice, which proves the file was not re-read.
    writeFileSync(path, '---\npriority: archived\n---\nbody', 'utf8');
    fs.utimesSync(path, 1_700_000_000, 1_700_000_000);
    expect(mem.readExplicitTier(path, mtimeMs)).toBe('pinned');
  });

  it('re-reads when the leaf changes (new mtime)', async () => {
    const mem = await import('../electron/memory');
    const first = leaf('c2.md', '---\npriority: pinned\n---\nbody', 1_700_000_000);
    expect(mem.readExplicitTier(first.path, first.mtimeMs)).toBe('pinned');
    const second = leaf('c2.md', '---\npriority: archived\n---\nbody', 1_700_000_500);
    expect(mem.readExplicitTier(second.path, second.mtimeMs)).toBe('archived');
  });
});

describe('source guards', () => {
  it('the tier reader never reads a whole file', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(__dirname, '..', 'electron', 'memory.ts'), 'utf8');
    const start = src.indexOf('function readExplicitTierUncached');
    const body = src.slice(start, src.indexOf('\n}', start));
    expect(body).toMatch(/readSync\(fd, buf, 0, FRONTMATTER_PEEK_BYTES, 0\)/);
    expect(body).not.toMatch(/readFileSync\(/);
  });

  it('getEffectiveTier passes the mtime so the cache is used', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(__dirname, '..', 'electron', 'memory.ts'), 'utf8');
    expect(src).toMatch(/const explicit = readExplicitTier\(path, mtimeMs\);/);
  });
});
