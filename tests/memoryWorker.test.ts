/**
 * Memory loads at turn start must not block the main process.
 *
 * Measured over a day of real use: 61 of 71 turn starts (86%) missed the
 * memory cache, and each miss read ~2,000 markdown files synchronously on the
 * Electron main process - median 11s, worst 64s - while other sessions
 * streamed and ran tools against the same disk. That is the freeze "almost
 * every time I try to do something". A miss is now computed in a worker
 * thread; the result is identical, and the app keeps responding meanwhile.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const memSrc = readFileSync(join(__dirname, '..', 'electron', 'memory.ts'), 'utf8');
const agentSrc = readFileSync(join(__dirname, '..', 'electron', 'agent.ts'), 'utf8');
const viteSrc = readFileSync(join(__dirname, '..', 'vite.config.ts'), 'utf8');
const workerSrc = readFileSync(join(__dirname, '..', 'electron', 'memoryWorker.ts'), 'utf8');

describe('turn start uses the async loader', () => {
  it('agent awaits loadMemoryAsync, never the synchronous loader', () => {
    expect(agentSrc).toMatch(/await instrumentAsync\('agent: loadMemory', \(\) =>\s*\n?\s*loadMemoryAsync\(\{ cwd, projectId \}\)/);
    expect(agentSrc).not.toMatch(/[^A-Za-z]loadMemory\(\{/);
  });
});

describe('loadMemoryAsync', () => {
  it('falls back to an inline load when no worker is available, with the same result', async () => {
    // Under vitest there is no built memoryWorker.js next to the module, so
    // the worker is unavailable and the fallback path runs.
    const mem = await import('../electron/memory');
    const args = { cwd: '', projectId: '__guy_test_fallback__' };
    const a = await mem.loadMemoryAsync(args);
    const b = mem.loadMemoryUncachedForWorker(args);
    expect(a.text).toBe(b.text);
    expect(a.sources).toEqual(b.sources);
  });

  it('serves the second call from the cache', async () => {
    const mem = await import('../electron/memory');
    const args = { cwd: '', projectId: '__guy_test_cache__' };
    const first = await mem.loadMemoryAsync(args);
    const second = await mem.loadMemoryAsync(args);
    expect(second).toBe(first); // same object = cache hit
  });

  it('collapses concurrent misses for the same session into one load', async () => {
    const mem = await import('../electron/memory');
    const args = { cwd: '', projectId: '__guy_test_inflight__' };
    const [x, y] = await Promise.all([mem.loadMemoryAsync(args), mem.loadMemoryAsync(args)]);
    expect(y).toBe(x);
  });
});

describe('the worker is wired into the build and is Electron-free', () => {
  it('vite emits memoryWorker as its own entry next to main', () => {
    expect(viteSrc).toMatch(/entry: \['electron\/main\.ts', 'electron\/memoryWorker\.ts'\]/);
  });

  it('memory.ts starts it from the same output directory', () => {
    expect(memSrc).toMatch(/join\(__dirname, 'memoryWorker\.js'\)/);
  });

  it('the worker only uses node built-ins plus memory.ts (no electron module)', () => {
    expect(workerSrc).not.toMatch(/from 'electron'/);
    expect(workerSrc).toMatch(/from 'node:worker_threads'/);
    expect(memSrc).not.toMatch(/from 'electron'/);
  });

  it('a stuck worker cannot hang a turn: it times out and the load runs inline', () => {
    expect(memSrc).toMatch(/const WORKER_TIMEOUT_MS = [\d_]+/);
    expect(memSrc).toMatch(/worker load failed .*loading inline/);
  });
});
