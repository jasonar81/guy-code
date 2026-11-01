/**
 * The startup title scan reads only what a transcript has GAINED.
 *
 * Transcripts are append-only. 1.6.1 skipped unchanged files, but any file
 * that had changed was still re-read and re-parsed IN FULL - and the files
 * that change are the active sessions, which are also the biggest (169MB,
 * 37MB, 35MB on a real install). Startup still blocked the main process for
 * ~29 seconds. Now a file that only grew is scanned from where the last scan
 * stopped: a new title event can only be in that tail.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '..', 'electron', 'claudeImport.ts'), 'utf8');
const start = src.indexOf('export function backfillTitles');
const body = src.slice(start, src.indexOf('\n}', start));

describe('backfillTitles reads only the new tail of a grown transcript', () => {
  it('uses the size recorded by the last scan as the starting offset', () => {
    expect(body).toMatch(/const prevSize = Number\(String\(seen\[t\.id\] \?\? ''\)\.split\(':'\)\[0\]\) \|\| 0;/);
  });

  it('only tails a file that GREW and already has a title', () => {
    // shrunk/rewritten files and untitled sessions still get the full read
    expect(body).toMatch(/const canTail = prevSize > 0 && size > prevSize && !!t\.title;/);
    expect(body).toMatch(/text = readTail\(t\.jsonl_path, prevSize, size\)/);
    expect(body).toMatch(/text = readFileSync\(t\.jsonl_path, 'utf8'\)/);
  });

  it('drops the partial first line of the tail', () => {
    expect(body).toMatch(/const nl = text\.indexOf\('\\n'\);/);
  });

  it('leaves the title alone when the tail has no new title event', () => {
    expect(body).toMatch(/if \(canTail && !customTitle && !aiTitle\) continue;/);
  });

  it('a rename found in the tail wins, with the old title as the fallback', () => {
    expect(body).toMatch(/bestTitle\(\{ customTitle, aiTitle, firstUserPreview: t\.title \?\? undefined \}\)/);
  });

  it('readTail reads a byte range without loading the whole file', () => {
    const h = src.slice(src.indexOf('function readTail'), src.indexOf('function readTail') + 600);
    expect(h).toMatch(/readSync\(fd, buf, 0, len, from\)/);
    expect(h).not.toMatch(/readFileSync/);
  });
});
