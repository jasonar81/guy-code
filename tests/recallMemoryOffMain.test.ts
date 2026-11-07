/**
 * recall_memory must not block the main process, and listing memory must not
 * read whole files.
 *
 * 2026-11-07: a 62-second "Not Responding" at 16:17 and an 18-second one at
 * 13:39 each spanned exactly one recall_memory call. A search that matches
 * little reads every leaf in full - 2,495 files / 36.9 MB on this install -
 * and it ran synchronously on the Electron main process. It now runs in the
 * memory worker. The per-leaf description readers (parseMdFrontmatter,
 * firstLine) also read whole files - 48.7 MB per gatherLeafMeta call - and now
 * read the head only, widening until the answer is the same as a full read.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const memSrc = readFileSync(join(__dirname, '..', 'electron', 'memory.ts'), 'utf8');
const toolsSrc = readFileSync(join(__dirname, '..', 'electron', 'tools.ts'), 'utf8');
const workerSrc = readFileSync(join(__dirname, '..', 'electron', 'memoryWorker.ts'), 'utf8');

describe('recall_memory runs off the main process', () => {
  it('the tool awaits the async (worker) search', () => {
    const at = toolsSrc.indexOf("name: 'recall_memory'");
    const body = toolsSrc.slice(at, at + 1800);
    expect(body).toMatch(/return recallFromDiskAsync\(\{/);
    expect(body).not.toMatch(/return recallFromDisk\(\{/);
  });

  it('the worker handles a recall job', () => {
    expect(workerSrc).toMatch(/msg\.kind === 'recall'/);
    expect(workerSrc).toMatch(/recallFromDisk\(\{/);
  });

  it('falls back to an inline search with the same answer when no worker is available', async () => {
    const mem = await import('../electron/memory');
    const args = { cwd: '', projectId: '__guy_test_recall__', query: 'zzz-no-such-term-zzz' };
    expect(await mem.recallFromDiskAsync(args)).toBe(mem.recallFromDisk(args));
  });
});

describe('parseMdFrontmatter reads only what it needs, with the same answer', () => {
  let dir = '';
  const leaf = (name: string, body: string) => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), 'fmpeek-'));
    const p = join(dir, name);
    writeFileSync(p, body, 'utf8');
    return p;
  };

  it('frontmatter name/description', async () => {
    const { parseMdFrontmatter } = await import('../electron/memory');
    const p = leaf('a.md', '---\nname: Alpha\ndescription: the alpha leaf\n---\nbody');
    expect(parseMdFrontmatter(p)).toEqual({ name: 'Alpha', description: 'the alpha leaf' });
  });

  it('first content line when the file opens with many KB of headings', async () => {
    const { parseMdFrontmatter } = await import('../electron/memory');
    const headings = Array.from({ length: 400 }, (_, i) => `# heading ${i} ${'x'.repeat(30)}`).join('\n');
    const p = leaf('b.md', `${headings}\nthe real first line\nmore`);
    expect(parseMdFrontmatter(p).description).toBe('the real first line');
  });

  it('never returns a line cut off at the read boundary', async () => {
    const { parseMdFrontmatter } = await import('../electron/memory');
    // A ~5KB first line straddles the 4KB peek; the answer must be the
    // full line's 200-char prefix, exactly as a full read gives.
    const long = 'L'.repeat(5000);
    const p = leaf('c.md', `# title\n${long}\nnext`);
    expect(parseMdFrontmatter(p).description).toBe(long.slice(0, 200));
  });

  it('multi-byte text is not mistaken for end-of-file', async () => {
    const { parseMdFrontmatter } = await import('../electron/memory');
    const headings = Array.from({ length: 200 }, () => '# ★★★★★★★★★★ heading').join('\n');
    const p = leaf('d.md', `${headings}\nfirst real line`);
    expect(parseMdFrontmatter(p).description).toBe('first real line');
  });
});

describe('source guards', () => {
  it('parseMdFrontmatter no longer starts with a whole-file read', () => {
    const at = memSrc.indexOf('export function parseMdFrontmatter');
    const head = memSrc.slice(at, at + 2500);
    expect(head).toMatch(/for \(const limit of \[FRONTMATTER_PEEK_BYTES, 65536, Infinity\]\)/);
    expect(head).toMatch(/reachedEnd = got < limit;/);
  });
});
