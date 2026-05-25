/**
 * Tests for `electron/toolSummarizer.ts`.
 *
 * The summarizer is invoked between executeTool() and the model's
 * tool_result block. Bugs here either:
 *   • silently truncate something the model needed (correctness), or
 *   • blow up context with un-summarized 50K-char dumps (cost).
 *
 * Coverage target:
 *   • Pass-through behaviors: small outputs, errors, NEVER_SUMMARIZE
 *     tool names. None of these should hit disk.
 *   • Per-tool summary shapes: head+tail, line counts, error/warning
 *     counters, file breakdowns. Each summarizer has its own format
 *     contract and we lock that down.
 *   • Archive on disk: file exists, contains the FULL raw output,
 *     sidecar JSON has tool name + timestamp.
 *   • Cleanup sweep: deletes old files, keeps fresh ones, removes
 *     empty session directories.
 *
 * Strategy: redirect the archive root to a per-test temp directory
 * via the `_setArchiveRootForTesting` seam. Real filesystem access
 * keeps the tests honest about the on-disk contract; using the real
 * homedir would scribble test artifacts into the user's actual
 * ~/.guycode/.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Each test gets its own temp archive root via `_setArchiveRootForTesting`.
// Earlier we tried vi.mock('node:os') to swap homedir(), but vitest 4's
// handling of the `node:` prefix is unreliable across ESM/CJS module
// resolution and the mock didn't reach inside toolSummarizer's import.
// A direct setter is simpler, more obvious, and impossible to silently
// no-op.
import {
  maybeSummarize,
  cleanupArchives,
  _setArchiveRootForTesting,
} from '../electron/toolSummarizer';

let _archiveRoot = '';

beforeEach(() => {
  _archiveRoot = mkdtempSync(join(tmpdir(), 'guycode-summarizer-'));
  _setArchiveRootForTesting(_archiveRoot);
});

afterEach(() => {
  _setArchiveRootForTesting(null);
  if (_archiveRoot) {
    try {
      rmSync(_archiveRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  _archiveRoot = '';
});

function archivePath(sessionId: string, callId: string): string {
  return join(_archiveRoot, sessionId, `${callId}.txt`);
}

function sidecarPath(sessionId: string, callId: string): string {
  return join(_archiveRoot, sessionId, `${callId}.json`);
}

// ---- Pass-through behaviors --------------------------------------------

describe('maybeSummarize pass-through', () => {
  it('passes small outputs through unchanged with no archive', () => {
    const r = maybeSummarize({
      toolName: 'Bash',
      toolInput: { command: 'echo hi' },
      sessionId: 'sess-A',
      toolUseId: 'call-1',
      rawContent: 'hello\nworld',
      isError: false,
    });
    expect(r.content).toBe('hello\nworld');
    expect(r.archivePath).toBeNull();
    expect(r.originalChars).toBe(0);
    expect(existsSync(archivePath('sess-A', 'call-1'))).toBe(false);
  });

  it('passes errors through verbatim regardless of size', () => {
    const big = 'BOOM\n'.repeat(10_000); // 50K chars, well above any threshold
    const r = maybeSummarize({
      toolName: 'Bash',
      toolInput: {},
      sessionId: 'sess-A',
      toolUseId: 'call-2',
      rawContent: big,
      isError: true,
    });
    expect(r.content).toBe(big);
    expect(r.archivePath).toBeNull();
    expect(existsSync(archivePath('sess-A', 'call-2'))).toBe(false);
  });

  it('NEVER summarizes the skill tool body', () => {
    // Skills bodies are instruction sets — truncating breaks the skill.
    const skill = 'STEP 1: do thing\n'.repeat(5000);
    const r = maybeSummarize({
      toolName: 'skill',
      toolInput: { SkillName: 'feature-spec' },
      sessionId: 'sess-A',
      toolUseId: 'call-3',
      rawContent: skill,
      isError: false,
    });
    expect(r.content).toBe(skill);
    expect(r.archivePath).toBeNull();
  });

  it('NEVER summarizes Plan / TodoWrite / Task / subagent results', () => {
    const big = 'x'.repeat(50_000);
    for (const name of ['TodoWrite', 'Plan', 'Task', 'Execute', 'Review']) {
      const r = maybeSummarize({
        toolName: name,
        toolInput: {},
        sessionId: 'sess-A',
        toolUseId: `call-${name}`,
        rawContent: big,
        isError: false,
      });
      expect(r.content, `tool=${name}`).toBe(big);
      expect(r.archivePath, `tool=${name}`).toBeNull();
    }
  });
});

// ---- Per-tool summarizers ----------------------------------------------

describe('Bash / PowerShell summary', () => {
  it('archives + replaces with head+tail+marker counts when over threshold', () => {
    // 12,000-char threshold — produce ~15K chars with embedded markers.
    const lines: string[] = [];
    for (let i = 0; i < 300; i++)
      lines.push(`line ${i} normal output text padding padding padding more padding`);
    lines[10] = 'ERROR: something went wrong';
    lines[20] = 'WARNING: deprecated';
    lines[30] = 'task failed: connection refused';
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(12_000);
    const r = maybeSummarize({
      toolName: 'Bash',
      toolInput: { command: 'big' },
      sessionId: 'sess-B',
      toolUseId: 'call-bash',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    expect(r.content).toMatch(/Output was large/);
    expect(r.content).toMatch(/First 50 lines/);
    expect(r.content).toMatch(/Last 30 lines/);
    expect(r.content).toMatch(/skipped .* middle lines/);
    // Marker counts surfaced
    expect(r.content).toMatch(/1 error\/fatal\/panic/);
    expect(r.content).toMatch(/1 warning/);
    expect(r.content).toMatch(/1 fail\/failure/);
    // Full output is on disk and untouched
    const archived = readFileSync(r.archivePath!, 'utf8');
    expect(archived).toBe(raw);
  });

  it('treats PowerShell identically to Bash', () => {
    const raw = 'a\n'.repeat(8000); // 16K chars
    const r = maybeSummarize({
      toolName: 'PowerShell',
      toolInput: {},
      sessionId: 'sess-B',
      toolUseId: 'call-ps',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    expect(r.content).toMatch(/First 50 lines/);
  });
});

describe('Read summary', () => {
  it('preserves total line count and head+tail when over threshold', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'x'.repeat(20)}`);
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(16_000);
    const r = maybeSummarize({
      toolName: 'Read',
      toolInput: { file_path: '/tmp/big.txt' },
      sessionId: 'sess-R',
      toolUseId: 'call-read',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    expect(r.content).toMatch(/Total: 1,000 lines/);
    expect(r.content).toMatch(/First 60 lines/);
    expect(r.content).toMatch(/Last 30 lines/);
  });

  it('Read threshold is higher than Bash (16K vs 12K)', () => {
    // 13K chars: above Bash threshold but below Read threshold
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(120)}`);
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(12_000);
    expect(raw.length).toBeLessThan(16_000);
    const r = maybeSummarize({
      toolName: 'Read',
      toolInput: {},
      sessionId: 'sess-R',
      toolUseId: 'call-read-2',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).toBeNull();
    expect(r.content).toBe(raw);
  });
});

describe('Grep summary', () => {
  it('shows top files by match count and total', () => {
    const lines: string[] = [];
    // 100 matches in foo.ts, 50 in bar.ts, 30 in baz.ts → 180 total
    for (let i = 0; i < 100; i++)
      lines.push(`src/foo.ts:${i + 1}:5:found here ${i} extra padding for size`);
    for (let i = 0; i < 50; i++)
      lines.push(`src/bar.ts:${i + 1}:3:found here ${i} extra padding for size`);
    for (let i = 0; i < 30; i++)
      lines.push(`src/baz.ts:${i + 1}:7:found here ${i} extra padding for size`);
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(6_000);
    const r = maybeSummarize({
      toolName: 'Grep',
      toolInput: { pattern: 'found' },
      sessionId: 'sess-G',
      toolUseId: 'call-grep',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    expect(r.content).toMatch(/Total: 180 matches across 3 files/);
    expect(r.content).toMatch(/First 30 matches/);
    expect(r.content).toMatch(/150 more matches/);
    expect(r.content).toMatch(/Top files by match count/);
    expect(r.content).toMatch(/100 src\/foo\.ts/);
    expect(r.content).toMatch(/50 src\/bar\.ts/);
  });

  it('uses Grep threshold (6K) which is lower than Bash', () => {
    // 7K-char Grep should summarize; same content under Bash should too
    // but the test pin is the Grep-specific threshold.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++)
      lines.push(`f.ts:${i}:1:m${i.toString().padStart(35, ' ')}`);
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(6_000);
    expect(raw.length).toBeLessThan(12_000);
    const r = maybeSummarize({
      toolName: 'Grep',
      toolInput: {},
      sessionId: 'sess-G',
      toolUseId: 'call-grep-2',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
  });
});

describe('Glob summary', () => {
  it('buckets paths by top-level segment', () => {
    const lines: string[] = [];
    for (let i = 0; i < 200; i++)
      lines.push(`src/components/very/deeply/nested/Foo${i}.tsx`);
    for (let i = 0; i < 100; i++)
      lines.push(`tests/unit/integration/Test${i}.spec.ts`);
    for (let i = 0; i < 60; i++)
      lines.push(`docs/guides/howto/Guide${i}.md`);
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(6_000);
    const r = maybeSummarize({
      toolName: 'Glob',
      toolInput: { pattern: '**/*' },
      sessionId: 'sess-Gl',
      toolUseId: 'call-glob',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    expect(r.content).toMatch(/Total: 360 paths/);
    expect(r.content).toMatch(/Top top-level segments/);
    expect(r.content).toMatch(/200 src/);
    expect(r.content).toMatch(/100 tests/);
    expect(r.content).toMatch(/60 docs/);
  });
});

describe('WebFetch summary', () => {
  it('preserves Title/URL meta and shows first 1500 chars of body', () => {
    const meta = ['Title: My Page', 'URL: https://example.com/page'];
    const body = 'This is the body. '.repeat(2000); // way more than 1500
    const raw = meta.join('\n') + '\n\n' + body;
    expect(raw.length).toBeGreaterThan(16_000);
    const r = maybeSummarize({
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/page' },
      sessionId: 'sess-W',
      toolUseId: 'call-web',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    expect(r.content).toMatch(/Title: My Page/);
    expect(r.content).toMatch(/URL: https:\/\/example\.com\/page/);
    expect(r.content).toMatch(/Body length: /);
    // First 1500 chars of body shown, then ellipsis (single-char unicode '…').
    expect(r.content).toMatch(/…/);
  });
});

describe('generic fallback summarizer', () => {
  it('handles unknown tool names with head+tail+skipped', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `row ${i} payload payload payload`);
    const raw = lines.join('\n');
    expect(raw.length).toBeGreaterThan(12_000);
    const r = maybeSummarize({
      toolName: 'SomeNewToolWeAddedLater',
      toolInput: {},
      sessionId: 'sess-X',
      toolUseId: 'call-x',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    expect(r.content).toMatch(/First 60 lines/);
    expect(r.content).toMatch(/Last 30 lines/);
    expect(r.content).toMatch(/skipped .* middle lines/);
  });
});

// ---- Archive correctness -----------------------------------------------

describe('archive on disk', () => {
  it('writes a sidecar JSON with tool metadata + timestamp', () => {
    const raw = 'x'.repeat(15_000);
    const r = maybeSummarize({
      toolName: 'Bash',
      toolInput: { command: 'big', timeout_ms: 5000 },
      sessionId: 'sess-A',
      toolUseId: 'call-meta',
      rawContent: raw,
      isError: false,
    });
    expect(r.archivePath).not.toBeNull();
    const sidecar = JSON.parse(readFileSync(sidecarPath('sess-A', 'call-meta'), 'utf8'));
    expect(sidecar.toolName).toBe('Bash');
    expect(sidecar.toolUseId).toBe('call-meta');
    expect(sidecar.sessionId).toBe('sess-A');
    expect(sidecar.chars).toBe(raw.length);
    expect(typeof sidecar.archivedAt).toBe('number');
    expect(sidecar.inputPreview.command).toBe('big');
    expect(sidecar.inputPreview.timeout_ms).toBe(5000);
  });

  it('truncates very long string fields in inputPreview', () => {
    const longCmd = 'x'.repeat(5000);
    maybeSummarize({
      toolName: 'Bash',
      toolInput: { command: longCmd },
      sessionId: 'sess-A',
      toolUseId: 'call-long',
      rawContent: 'y'.repeat(15_000),
      isError: false,
    });
    const sidecar = JSON.parse(readFileSync(sidecarPath('sess-A', 'call-long'), 'utf8'));
    // Preview is capped at 200 chars + ellipsis
    expect(sidecar.inputPreview.command.length).toBeLessThan(longCmd.length);
    expect(sidecar.inputPreview.command).toMatch(/…$/);
  });

  it('embeds the absolute archive path in the summary text', () => {
    const r = maybeSummarize({
      toolName: 'Bash',
      toolInput: {},
      sessionId: 'sess-A',
      toolUseId: 'call-path',
      rawContent: 'q\n'.repeat(8000),
      isError: false,
    });
    expect(r.content).toContain(r.archivePath!);
    expect(r.content).toMatch(/Use Read with that absolute path/);
  });
});

// ---- Cleanup sweep -----------------------------------------------------

describe('cleanupArchives', () => {
  it('deletes files older than 30 days, keeps fresh ones', () => {
    // Seed: one fresh file, one stale file (mtime 60d ago).
    const dir = join(_archiveRoot, 'sess-Z');
    mkdirSync(dir, { recursive: true });
    const fresh = join(dir, 'fresh.txt');
    const stale = join(dir, 'stale.txt');
    writeFileSync(fresh, 'fresh');
    writeFileSync(stale, 'stale');
    // Backdate stale by 60 days.
    const sixtyDaysAgo = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, sixtyDaysAgo, sixtyDaysAgo);
    cleanupArchives();
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  it('removes session directories that became empty after sweep', () => {
    const dir = join(_archiveRoot, 'sess-Empty');
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, 'old.txt');
    writeFileSync(stale, 'old');
    const sixtyDaysAgo = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, sixtyDaysAgo, sixtyDaysAgo);
    cleanupArchives();
    expect(existsSync(dir)).toBe(false);
  });

  it('is a no-op when the archive root does not exist yet', () => {
    // Brand-new fakeHome — no .guycode dir yet.
    expect(() => cleanupArchives()).not.toThrow();
  });

  it('preserves session directories that still have fresh files', () => {
    const dir = join(_archiveRoot, 'sess-Mixed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fresh.txt'), 'fresh');
    const stale = join(dir, 'stale.txt');
    writeFileSync(stale, 'stale');
    const sixtyDaysAgo = (Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, sixtyDaysAgo, sixtyDaysAgo);
    cleanupArchives();
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'fresh.txt'))).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });
});
