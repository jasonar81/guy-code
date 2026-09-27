/**
 * The startup title backfill.
 *
 * It ran at every launch and read + JSON.parsed EVERY session transcript in
 * full. On a real install that is 814 files / 1.5GB / 730,590 lines - measured
 * at 13s of parsing, and ~48s of frozen main process once the per-session DB
 * writes are counted. It was the longest remaining freeze after the database
 * flush was fixed.
 *
 * A title can only change if the file changed, so unchanged transcripts are
 * skipped via a size+mtime index: 13,140ms -> 41ms.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'electron', 'claudeImport.ts'), 'utf8');

function bodyOf(decl: string): string {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  return src.slice(i, src.indexOf('\n}', i));
}

describe('backfillTitles skips unchanged transcripts', () => {
  const body = bodyOf('export function backfillTitles');

  it('stats each file and compares against a saved stamp', () => {
    expect(body).toMatch(/statSync\(t\.jsonl_path\)/);
    expect(body).toMatch(/\$\{st\.size\}:\$\{st\.mtimeMs\}/);
  });

  it('CONTINUES (does not read the file) when the stamp is unchanged', () => {
    expect(body).toMatch(/if \(seen\[t\.id\] === stamp\)/);
    // The skip must happen BEFORE the expensive read.
    const skipAt = body.indexOf('seen[t.id] === stamp');
    const readAt = body.indexOf('readFileSync(t.jsonl_path');
    expect(skipAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(skipAt);
  });

  it('still scans a file whose stat fails (correctness over speed)', () => {
    // The stat is wrapped so a failure falls through to a full scan.
    expect(body).toMatch(/catch \{[\s\S]*fall through and scan it/);
  });

  it('persists the index for next launch', () => {
    expect(body).toMatch(/setTitleScanIndex\(nextIndex\)/);
    expect(src).toMatch(/function getTitleScanIndex/);
    expect(src).toMatch(/function setTitleScanIndex/);
  });

  it('logs how many it skipped, so the win is visible', () => {
    expect(body).toMatch(/unchanged, skipped/);
  });

  it('records a stamp for EVERY session, including ones it scans', () => {
    // Otherwise a scanned file would be re-scanned forever.
    expect(body).toMatch(/nextIndex\[t\.id\] = stamp/);
  });
});

describe('the scan index is a cache, not state we depend on', () => {
  it('a corrupt index degrades to a full scan rather than throwing', () => {
    const g = bodyOf('function getTitleScanIndex');
    expect(g).toMatch(/catch \{\s*return \{\};/);
  });

  it('failing to persist the index does not break startup', () => {
    const s = bodyOf('function setTitleScanIndex');
    expect(s).toMatch(/catch \(e\)[\s\S]*log\.warn/);
  });
});
