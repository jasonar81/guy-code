/**
 * loadMemory is cached.
 *
 * It reads the whole memory tree - 3,024 .md files / 48MB on a real install -
 * synchronously on the main process, BEFORE EVERY TURN. Idle that is ~130ms,
 * but with several sessions and subagents hitting the same disk it was
 * measured at 8s, 15s, 21s and 32s. The v1.6.3 instrumentation named it
 * outright: "agent: loadMemory" was the ONLY slow operation in the log,
 * 86 seconds across 7 calls.
 *
 * The content barely changes between turns, so the bundle is reused until
 * either the memory directories are touched or a short TTL expires - and any
 * write through saveMemory/setMemoryPriority/delete clears it immediately.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'electron', 'memory.ts'), 'utf8');

/**
 * Source of a function. Note `loadMemory(args: {...})` has an inline object
 * type, so the first `\n}` is the END OF THAT TYPE, not the function - take a
 * generous window instead and let the assertions do the work.
 */
function bodyOf(decl: string, chars = 2500): string {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  return src.slice(i, i + chars);
}

describe('loadMemory caching', () => {
  it('returns a cached bundle instead of re-reading every turn', () => {
    const body = bodyOf('export function loadMemory');
    expect(body).toMatch(/_bundleCache/);
    expect(body).toMatch(/return cached\.bundle/);
  });

  it('the real work moved to loadMemoryUncached', () => {
    expect(src).toMatch(/function loadMemoryUncached/);
    const body = bodyOf('export function loadMemory');
    expect(body).toMatch(/loadMemoryUncached\(args\)/);
  });

  it('keys the cache on cwd AND projectId (different sessions differ)', () => {
    const body = bodyOf('export function loadMemory');
    expect(body).toMatch(/const key = `\$\{args\.projectId\}/);
    expect(body).toMatch(/_bundleCache\.get\(key\)/);
  });

  /**
   * The first version of this cache MISSED EVERY TIME and loadMemory still
   * took 23s and 35s in production. Two reasons, both guarded here.
   */
  it('holds MANY entries - concurrent sessions must not evict each other', () => {
    expect(src).toMatch(/_bundleCache = new Map</);
    const body = bodyOf('export function loadMemory');
    expect(body).toMatch(/_bundleCache\.set\(key/);
    // and it stays bounded
    expect(body).toMatch(/_bundleCache\.size > \d+/);
  });

  it('does NOT include cwd in the freshness stamp (agents write there constantly)', () => {
    const stamp = bodyOf('function memoryTreeStamp', 900);
    // The parameter is deliberately unused.
    expect(stamp).toMatch(/_cwd: string/);
    // The directory list must not contain a bare `cwd` entry.
    const dirList = stamp.slice(stamp.indexOf('const dirs'), stamp.indexOf(']'));
    expect(dirList).not.toMatch(/^\s*cwd,\s*$/m);
  });

  it('re-reads when the memory directories change', () => {
    const body = bodyOf('export function loadMemory');
    expect(body).toMatch(/cached\.stamp === memoryTreeStamp/);
    const stamp = bodyOf('function memoryTreeStamp');
    // Stats DIRECTORIES, not all 3,024 files - the check must stay cheap.
    expect(stamp).toMatch(/statSync\(d\)/);
    expect(stamp).toMatch(/mtimeMs/);
  });

  it('bounds staleness with a TTL as well', () => {
    expect(src).toMatch(/const MEMORY_CACHE_MS = [\d_]+/);
    const ms = Number(src.match(/const MEMORY_CACHE_MS = ([\d_]+)/)![1].replace(/_/g, ''));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(300_000);
  });

  it('the staleness check is cheap - it does not stat every leaf', () => {
    const stamp = bodyOf('function memoryTreeStamp');
    expect(stamp).not.toMatch(/readdirSync/);
    expect(stamp).not.toMatch(/readFileSync/);
  });
});

describe('writes invalidate the cache immediately', () => {
  it('exports an invalidate function', () => {
    expect(src).toMatch(/export function invalidateMemoryCache/);
  });

  it('saving, re-prioritising and deleting a leaf all clear it', () => {
    // 1 definition + 3 call sites (save, setPriority, delete).
    const hits = src.match(/invalidateMemoryCache\(\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
});
