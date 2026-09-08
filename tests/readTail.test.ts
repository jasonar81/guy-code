/**
 * The bounded tail read for session transcripts.
 *
 * Transcripts grow without bound (157MB in the wild). The loaders keep only the
 * last N messages but used to read + UTF-8 decode + JSON.parse the WHOLE file
 * on the main process - measured at 548ms of hard blocking per load on that
 * 157MB file, which is what produced "(Not Responding)". Reading a bounded tail
 * gives the same recent messages for 39ms.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTailUtf8 } from '../electron/sessionRuntime';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'guytail-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
};

describe('readTailUtf8', () => {
  it('returns the whole file when it is under the cap', () => {
    const p = write('small.jsonl', 'a\nb\nc\n');
    expect(readTailUtf8(p, 1024)).toBe('a\nb\nc\n');
  });

  it('returns an empty string for an empty file', () => {
    const p = write('empty.jsonl', '');
    expect(readTailUtf8(p, 1024)).toBe('');
  });

  it('returns only the tail when the file exceeds the cap', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n');
    const p = write('big.jsonl', lines);
    const tail = readTailUtf8(p, 200);
    expect(tail.length).toBeLessThanOrEqual(200);
    // The newest content is present, the oldest is not.
    expect(tail).toContain('line-499');
    expect(tail).not.toContain('line-0\n');
  });

  it('starts at a line boundary so no partial line is returned', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `{"n":${i}}`).join('\n');
    const p = write('bound.jsonl', lines);
    const tail = readTailUtf8(p, 100);
    // Every line must be parseable - a mid-line start would break the first.
    for (const l of tail.split('\n')) {
      if (!l.trim()) continue;
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });

  it('keeps enough history to satisfy a normal message limit', () => {
    // 5000 events, cap 1MB - should still yield thousands of lines.
    const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(50) })).join('\n');
    const p = write('hist.jsonl', lines);
    const tail = readTailUtf8(p, 1024 * 1024);
    const count = tail.split('\n').filter((l) => l.trim()).length;
    expect(count).toBeGreaterThan(1500);
  });
});
