/**
 * The database flush is THE cause of the constant "(Not Responding)".
 *
 * sql.js keeps the whole database in memory and persists by rewriting the
 * entire file. Measured on a real 656MB install: export() 278ms +
 * writeFileSync() 1438ms = 1.7 SECONDS of blocked main thread, every 5
 * seconds - about a third of all wall-clock time.
 *
 * Three things keep that from happening, and these tests pin all of them:
 *   1. the periodic write is ASYNC (never writeFileSync on the timer path)
 *   2. the interval BACKS OFF as the database grows
 *   3. old history is ROLLED UP so the file stays small - and every all-time
 *      cost query unions the rollup back in, so totals never change
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dbSrc = readFileSync(join(__dirname, '..', 'electron', 'db.ts'), 'utf8');

/** Body of a named function, for asserting on what it does. */
function bodyOf(src: string, decl: string): string {
  const i = src.indexOf(decl);
  if (i < 0) return '';
  return src.slice(i, src.indexOf('\n}', i));
}

describe('the periodic flush does not block the main thread', () => {
  it('has an async flush that awaits the file write', () => {
    const body = bodyOf(dbSrc, 'async function flushAsync');
    expect(body).toBeTruthy();
    expect(body).toMatch(/await fsp\.writeFile/);
    expect(body).toMatch(/await fsp\.rename/);
  });

  it('the TIMER uses the async flush, not the synchronous one', () => {
    // The synchronous flush() must survive for app-quit only.
    expect(dbSrc).toMatch(/setInterval\(\s*\(\)\s*=>\s*\{\s*void flushAsync\(\)/);
    expect(dbSrc).not.toMatch(/setInterval\(\(\) => flush\(\), 5000\)/);
  });

  it('still flushes synchronously on quit so nothing is lost', () => {
    const i = dbSrc.indexOf("app.on('before-quit'");
    expect(i).toBeGreaterThan(-1);
    expect(dbSrc.slice(i, i + 400)).toMatch(/\bflush\(\)/);
  });

  it('never runs two flushes at once', () => {
    const body = bodyOf(dbSrc, 'async function flushAsync');
    expect(body).toMatch(/_flushing/);
  });

  it('keeps the data dirty if the write fails, so it retries', () => {
    const body = bodyOf(dbSrc, 'async function flushAsync');
    expect(body).toMatch(/catch[\s\S]*_dirty = true/);
  });
});

describe('flush cadence backs off with database size', () => {
  it('a large database flushes far less often than a small one', () => {
    const body = bodyOf(dbSrc, 'function flushIntervalMs');
    expect(body).toBeTruthy();
    // Small DB: prompt. Large DB: infrequent.
    expect(body).toMatch(/return 5_000/);
    expect(body).toMatch(/60_000/);
    expect(body).toMatch(/mb > 400/);
  });
});

describe('compaction keeps the file small without losing cost history', () => {
  it('rolls old usage into a rollup table instead of deleting it', () => {
    const body = bodyOf(dbSrc, 'function compactDatabase');
    expect(body).toMatch(/INSERT INTO usage_rollup/);
    expect(body).toMatch(/DELETE FROM usage_events WHERE ts </);
    // VACUUM is what actually returns the space to the OS.
    expect(body).toMatch(/VACUUM/);
  });

  it('creates the rollup table in a migration', () => {
    expect(dbSrc).toMatch(/CREATE TABLE IF NOT EXISTS usage_rollup/);
  });

  it('ALL-TIME cost queries include the rollup (else totals would shrink)', () => {
    // listSessionsAll
    expect(dbSrc).toMatch(/UNION ALL[\s\S]*FROM usage_rollup WHERE source = 'live'/);
    // getSessionById
    expect(dbSrc).toMatch(/FROM usage_rollup\s*\n\s*WHERE source = 'live' AND session_id = s\.id/);
    // project totals
    expect(dbSrc).toMatch(/FROM usage_rollup r WHERE r\.project_id = p\.id/);
  });

  it('deleting a session also deletes its rolled-up cost', () => {
    const body = bodyOf(dbSrc, 'export function deleteSession');
    expect(body).toMatch(/DELETE FROM usage_rollup WHERE session_id = \?/);
  });

  it('compaction runs at startup and never throws', () => {
    expect(dbSrc).toMatch(/compactDatabase\(\);/);
    const body = bodyOf(dbSrc, 'function compactDatabase');
    expect(body).toMatch(/catch \(e\)[\s\S]*log\.error/);
  });

  /**
   * Startup-only compaction wasn't enough: on a busy install 335,666 usage
   * rows came back inside the retention window within days, taking the file
   * (and therefore every flush) back to 224MB.
   */
  it('also re-compacts on a timer, not just at startup', () => {
    expect(dbSrc).toMatch(/setInterval\(\s*\(\)\s*=>\s*\{\s*compactDatabase\(\)/);
    expect(dbSrc).toMatch(/clearInterval\(_compactTimer\)/);
  });

  it('strips fat tool-input blobs but keeps the audit rows', () => {
    const body = bodyOf(dbSrc, 'function compactDatabase');
    // UPDATE ... SET input_json = NULL, not DELETE - the trail survives.
    expect(body).toMatch(/UPDATE audit_events SET input_json = NULL/);
    expect(body).toMatch(/LENGTH\(input_json\) > 200/);
  });

  it('retention windows are tight enough to keep the file small', () => {
    const usage = Number(dbSrc.match(/const USAGE_DETAIL_DAYS = (\d+)/)?.[1]);
    const audit = Number(dbSrc.match(/const AUDIT_KEEP_DAYS = (\d+)/)?.[1]);
    expect(usage).toBeGreaterThan(0);
    expect(usage).toBeLessThanOrEqual(30);
    expect(audit).toBeGreaterThan(0);
    expect(audit).toBeLessThanOrEqual(30);
  });
});
