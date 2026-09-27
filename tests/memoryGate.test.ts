/**
 * The memory-relevance gate runs BEFORE EVERY TURN and blocks it.
 *
 * On a real machine it produced 15s and 34s freezes: the only thing between
 * "appended placeholder user message" and "loaded memory: 37 files" in the log
 * was this single network request, made with no timeout, against 567 saved
 * notes. A slow response froze the whole app.
 *
 * Two guards: a hard timeout (skip the optional notes rather than hang) and a
 * short-lived cache (the relevant set barely moves within one piece of work).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'electron', 'memoryRetrieval.ts'), 'utf8');

function bodyOf(decl: string): string {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  return src.slice(i, src.indexOf('\n}', i));
}

describe('the gate call cannot hang a turn', () => {
  const body = bodyOf('export async function gateTail');

  it('aborts the request after a bounded time', () => {
    expect(src).toMatch(/const GATE_TIMEOUT_MS = [\d_]+/);
    expect(body).toMatch(/new AbortController\(\)/);
    expect(body).toMatch(/setTimeout\(\(\) => ctrl\.abort\(\), GATE_TIMEOUT_MS\)/);
    expect(body).toMatch(/\{ signal: ctrl\.signal \}/);
  });

  it('clears the timer whatever happens', () => {
    expect(body).toMatch(/finally \{\s*clearTimeout\(timer\);/);
  });

  it('degrades to "no tail notes" instead of throwing', () => {
    // A timeout lands in the existing catch, which returns [].
    expect(body).toMatch(/catch \(e\)[\s\S]*return \[\];/);
  });

  it('uses a timeout short enough to be imperceptible', () => {
    const m = src.match(/const GATE_TIMEOUT_MS = ([\d_]+)/);
    expect(m).toBeTruthy();
    const ms = Number(m![1].replace(/_/g, ''));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});

describe('the gate is not called on every single turn', () => {
  const body = bodyOf('export async function gateTail');

  it('returns a cached answer when one is fresh', () => {
    expect(src).toMatch(/const GATE_CACHE_MS = [\d_]+/);
    expect(body).toMatch(/_gateCache\.get\(cacheKey\)/);
    expect(body).toMatch(/Date\.now\(\) - cached\.at < GATE_CACHE_MS/);
  });

  it('checks the cache BEFORE making the request', () => {
    const cacheAt = body.indexOf('_gateCache.get(cacheKey)');
    const callAt = body.indexOf('client.messages.create');
    expect(cacheAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(cacheAt);
  });

  it('stores the answer and bounds the cache', () => {
    expect(body).toMatch(/_gateCache\.set\(cacheKey/);
    expect(body).toMatch(/_gateCache\.size > \d+/);
  });

  it('still short-circuits when there are few candidates (no call at all)', () => {
    expect(body).toMatch(/if \(tail\.length <= GATE_MIN_CANDIDATES\) return tail\.map/);
  });
});
