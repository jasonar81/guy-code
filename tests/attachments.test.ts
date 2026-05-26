/**
 * Tests for `electron/attachments.ts` — the disk-backed attachment
 * subsystem shipped in v0.1.6 to remove the 200KB inline-text cap.
 *
 * What's covered:
 *   • `sanitizeAttachmentFilename` — path-traversal safety, control
 *     characters, Windows-reserved chars, leading dots, length cap,
 *     and the empty/pathological fallback. The function gates the
 *     ONLY surface the renderer can use to influence the leaf
 *     filename, so any escape here is a critical security bug.
 *   • `saveTextAttachment` round-trip — file lands at the expected
 *     path under the per-session dir, content is preserved byte for
 *     byte, and same-name collisions get unique names.
 *   • `deleteSessionAttachments` — wipes the per-session dir
 *     recursively and is a no-op when the dir doesn't exist.
 *   • `buildAttachmentPreview` — short text returns intact, long
 *     text gets truncated with the marker, leading whitespace is
 *     stripped.
 *
 * Strategy: `vi.mock('electron')` to swap `app.getPath('home')` to a
 * fresh tempdir per test run. This keeps the on-disk side effects
 * isolated and lets us assert on absolute paths without relying on
 * the developer's actual ~/.guycode dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let _testHome: string;

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'home') return _testHome;
      throw new Error(`unexpected app.getPath key in test: ${key}`);
    },
  },
}));

// Imports MUST come after vi.mock so the mock is hoisted before the
// module under test resolves its `electron` import.
import {
  attachmentsRoot,
  buildAttachmentPreview,
  deleteSessionAttachments,
  sanitizeAttachmentFilename,
  saveTextAttachment,
  sessionAttachmentDir,
} from '../electron/attachments';

beforeEach(() => {
  _testHome = mkdtempSync(join(tmpdir(), 'guycode-attach-test-'));
});

afterEach(() => {
  // Best-effort cleanup. Fresh tempdir per test means even a leak
  // here only costs a tempdir; it's not a correctness issue.
  try {
    rmSync(_testHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('sanitizeAttachmentFilename', () => {
  // ---- Path-traversal safety ---------------------------------------
  // The renderer is in-process and can pass any string here. These
  // tests confirm we never let an absolute path or `..` segment
  // escape the per-session dir.
  it('strips parent-dir escape attempts (POSIX style)', () => {
    expect(sanitizeAttachmentFilename('../../../etc/passwd')).toBe('passwd');
  });
  it('strips parent-dir escape attempts (Windows style)', () => {
    expect(sanitizeAttachmentFilename('..\\..\\Windows\\system32\\foo.txt')).toBe('foo.txt');
  });
  it('strips absolute POSIX paths', () => {
    expect(sanitizeAttachmentFilename('/usr/local/bin/secret.sh')).toBe('secret.sh');
  });
  it('strips drive-letter absolute paths', () => {
    expect(sanitizeAttachmentFilename('C:\\Users\\me\\diary.md')).toBe('diary.md');
  });
  it('handles mixed separators', () => {
    expect(sanitizeAttachmentFilename('a/b\\c/d.txt')).toBe('d.txt');
  });
  it('handles trailing slashes', () => {
    // `dir/` should not collapse to empty — we strip trailing slashes
    // before basename so we get the last meaningful segment.
    expect(sanitizeAttachmentFilename('foo/bar/')).toBe('bar');
  });

  // ---- Special / dangerous characters ------------------------------
  it('replaces Windows reserved chars with underscore', () => {
    const out = sanitizeAttachmentFilename('foo<bar>:"baz?.md');
    expect(out).not.toMatch(/[<>:"|?*]/);
    expect(out).toContain('foo_bar_');
    expect(out.endsWith('.md')).toBe(true);
  });
  it('replaces control characters', () => {
    const out = sanitizeAttachmentFilename('hello\u0000world\u0001.txt');
    expect(out).toMatch(/^hello_world_\.txt$|^hello__world_\.txt$/);
  });
  it('strips leading dots so we do not create a hidden file', () => {
    expect(sanitizeAttachmentFilename('.secret.env')).toBe('secret.env');
    expect(sanitizeAttachmentFilename('...hidden')).toBe('hidden');
  });
  it('strips leading whitespace', () => {
    expect(sanitizeAttachmentFilename('   spaced.md')).toBe('spaced.md');
  });
  it('collapses internal whitespace runs to a single space', () => {
    // Tabs are control characters (replaced with `_` by the
    // dangerous-char step BEFORE whitespace collapse), so they don't
    // round-trip as spaces. Plain space runs DO collapse.
    expect(sanitizeAttachmentFilename('a    b   c.md')).toBe('a b c.md');
    expect(sanitizeAttachmentFilename('a    b\t\tc.md')).toBe('a b_c.md');
  });

  // ---- Length cap --------------------------------------------------
  it('truncates very long names while preserving the extension', () => {
    const long = 'a'.repeat(500) + '.md';
    const out = sanitizeAttachmentFilename(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.md')).toBe(true);
  });
  it('truncates names with no useful extension', () => {
    const out = sanitizeAttachmentFilename('a'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(200);
  });

  // ---- Empty / pathological ----------------------------------------
  it('falls back when input is empty', () => {
    expect(sanitizeAttachmentFilename('')).toBe('attachment.txt');
  });
  it('falls back when input is only dots / underscores / whitespace', () => {
    expect(sanitizeAttachmentFilename('   ')).toBe('attachment.txt');
    expect(sanitizeAttachmentFilename('...')).toBe('attachment.txt');
    expect(sanitizeAttachmentFilename('___')).toBe('attachment.txt');
  });
  it('falls back when input is non-string', () => {
    // @ts-expect-error — exercising the runtime guard
    expect(sanitizeAttachmentFilename(undefined)).toBe('attachment.txt');
    // @ts-expect-error
    expect(sanitizeAttachmentFilename(null)).toBe('attachment.txt');
    // @ts-expect-error
    expect(sanitizeAttachmentFilename(42)).toBe('attachment.txt');
  });

  // ---- Common safe inputs pass through unchanged ------------------
  it('preserves typical filenames as-is', () => {
    expect(sanitizeAttachmentFilename('output.md')).toBe('output.md');
    expect(sanitizeAttachmentFilename('Refining Agent Output.md')).toBe('Refining Agent Output.md');
    expect(sanitizeAttachmentFilename('data-2024-01-15.csv')).toBe('data-2024-01-15.csv');
  });
});

describe('attachmentsRoot / sessionAttachmentDir', () => {
  it('returns a path under <home>/.guycode/attachments and creates it', () => {
    const root = attachmentsRoot();
    expect(root).toBe(join(_testHome, '.guycode', 'attachments'));
    expect(existsSync(root)).toBe(true);
  });

  it('per-session dir is the session id under the root', () => {
    const dir = sessionAttachmentDir('sess-abc');
    expect(dir).toBe(join(_testHome, '.guycode', 'attachments', 'sess-abc'));
    expect(existsSync(dir)).toBe(true);
  });

  it('idempotent: calling twice does not throw', () => {
    sessionAttachmentDir('sess-a');
    sessionAttachmentDir('sess-a');
    expect(existsSync(join(_testHome, '.guycode', 'attachments', 'sess-a'))).toBe(true);
  });
});

describe('saveTextAttachment', () => {
  it('writes the file under the per-session dir and returns the path', () => {
    const text = 'Hello world\nMultiple lines\n';
    const r = saveTextAttachment('sess-1', 'note.md', text);
    expect(existsSync(r.absPath)).toBe(true);
    expect(r.absPath).toContain(join(_testHome, '.guycode', 'attachments', 'sess-1'));
    expect(r.safeName).toBe('note.md');
    expect(r.sizeBytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('preserves UTF-8 content byte-for-byte', () => {
    const text = 'unicode: ñ é 中文 🚀\n' + 'X'.repeat(1000);
    const r = saveTextAttachment('sess-2', 'utf.md', text);
    const back = readFileSync(r.absPath, 'utf8');
    expect(back).toBe(text);
  });

  it('handles same-name collisions by adding a counter', () => {
    // Two saves with identical names should both succeed and land at
    // distinct paths. The timestamp prefix usually disambiguates;
    // when it doesn't (sub-millisecond), the counter does.
    const r1 = saveTextAttachment('sess-3', 'dup.md', 'first');
    const r2 = saveTextAttachment('sess-3', 'dup.md', 'second');
    expect(r1.absPath).not.toBe(r2.absPath);
    expect(readFileSync(r1.absPath, 'utf8')).toBe('first');
    expect(readFileSync(r2.absPath, 'utf8')).toBe('second');
  });

  it('sanitizes a malicious filename before writing', () => {
    const r = saveTextAttachment('sess-4', '../../etc/passwd', 'fake');
    // Must land under the per-session dir, never ../etc/passwd.
    const sessionDir = join(_testHome, '.guycode', 'attachments', 'sess-4');
    expect(r.absPath.startsWith(sessionDir)).toBe(true);
    expect(r.safeName).toBe('passwd');
  });

  it('falls back to attachment.txt for empty filenames', () => {
    const r = saveTextAttachment('sess-5', '', 'hello');
    expect(r.safeName).toBe('attachment.txt');
    expect(existsSync(r.absPath)).toBe(true);
  });

  it('writes empty text without error', () => {
    const r = saveTextAttachment('sess-6', 'empty.txt', '');
    expect(r.sizeBytes).toBe(0);
    expect(readFileSync(r.absPath, 'utf8')).toBe('');
  });
});

describe('deleteSessionAttachments', () => {
  it('removes the per-session dir and its contents', () => {
    saveTextAttachment('sess-del', 'a.md', 'x');
    saveTextAttachment('sess-del', 'b.md', 'y');
    const dir = join(_testHome, '.guycode', 'attachments', 'sess-del');
    expect(existsSync(dir)).toBe(true);

    deleteSessionAttachments('sess-del');

    expect(existsSync(dir)).toBe(false);
  });

  it('is a no-op when the session has no attachment dir', () => {
    // Must not throw. Common case: session never had any large
    // attachments, but `sessions:deleteFromDisk` calls us anyway.
    expect(() => deleteSessionAttachments('never-existed')).not.toThrow();
  });

  it('does not affect sibling sessions', () => {
    saveTextAttachment('sess-keep', 'a.md', 'keep me');
    saveTextAttachment('sess-drop', 'a.md', 'drop me');

    deleteSessionAttachments('sess-drop');

    expect(existsSync(join(_testHome, '.guycode', 'attachments', 'sess-keep'))).toBe(true);
    expect(existsSync(join(_testHome, '.guycode', 'attachments', 'sess-drop'))).toBe(false);
  });
});

describe('buildAttachmentPreview', () => {
  it('returns short text intact', () => {
    expect(buildAttachmentPreview('hello world', 500)).toBe('hello world');
  });

  it('strips leading whitespace so the preview starts at real content', () => {
    expect(buildAttachmentPreview('   \n\n  actual content', 500)).toBe('actual content');
  });

  it('truncates long text and appends a marker', () => {
    const long = 'A'.repeat(1000);
    const out = buildAttachmentPreview(long, 50);
    expect(out.startsWith('A'.repeat(50))).toBe(true);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(long.length);
  });

  it('default maxChars (500) caps long text', () => {
    const long = 'B'.repeat(2000);
    const out = buildAttachmentPreview(long);
    expect(out.startsWith('B'.repeat(500))).toBe(true);
    expect(out).toContain('truncated');
  });

  it('handles an exact-length boundary', () => {
    const exact = 'C'.repeat(100);
    const out = buildAttachmentPreview(exact, 100);
    expect(out).toBe(exact);
    expect(out).not.toContain('truncated');
  });

  it('handles empty input', () => {
    expect(buildAttachmentPreview('', 500)).toBe('');
  });
});
