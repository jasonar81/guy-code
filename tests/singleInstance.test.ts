/**
 * Only one Guy Code may run, and database writes must not share a temp file.
 *
 * On 2026-11-01 a second copy was launched while the first was still running
 * behind other windows. Both held the whole database in memory and wrote it
 * back on a timer, each overwriting the other's changes, and both used the
 * same "guycode.db.tmp" - 27 "async flush failed ENOENT rename" errors as each
 * copy renamed the other's temp file out from under it. To the user it looked
 * like the app had crashed and restarted.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const main = readFileSync(join(__dirname, '..', 'electron', 'main.ts'), 'utf8');
const db = readFileSync(join(__dirname, '..', 'electron', 'db.ts'), 'utf8');

describe('single-instance lock', () => {
  it('requests the lock and quits when another copy holds it', () => {
    expect(main).toMatch(/const gotTheLock = app\.requestSingleInstanceLock\(\);/);
    expect(main).toMatch(/if \(!gotTheLock\) \{[\s\S]{0,200}app\.quit\(\);/);
  });

  it('the lock is taken before the database is opened', () => {
    expect(main.indexOf('requestSingleInstanceLock')).toBeLessThan(main.indexOf('await initDb()'));
  });

  it('a losing copy never opens the database (app.quit is asynchronous)', () => {
    // Verified under real Electron: whenReady DOES fire in the losing copy.
    expect(main).toMatch(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]{0,400}if \(!gotTheLock\) return;[\s\S]{0,40}try \{\s*\n\s*await initDb\(\);/);
  });

  it('a second launch brings the existing window forward', () => {
    expect(main).toMatch(/app\.on\('second-instance'/);
    expect(main).toMatch(/w\.isMinimized\(\)\) w\.restore\(\)/);
    expect(main).toMatch(/w\.focus\(\)/);
  });
});

describe('database writes use a unique temp file', () => {
  it('no write uses the shared fixed ".tmp" name any more', () => {
    expect(db).not.toMatch(/_dbPath \+ '\.tmp'/);
  });

  it('the async flush names its temp file per process and per write', () => {
    expect(db).toMatch(/const tmpPath = `\$\{_dbPath\}\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}\.tmp`;/);
  });

  it('the synchronous (quit-time) flush uses its own distinct name', () => {
    expect(db).toMatch(/const tmpPath = `\$\{_dbPath\}\.\$\{process\.pid\}\.\$\{Date\.now\(\)\}\.sync\.tmp`;/);
  });

  it('a failed rename removes its own temp file', () => {
    expect(db).toMatch(/await fsp\.unlink\(tmpPath\)\.catch\(\(\) => \{\}\);/);
  });

  it('startup removes leftover temp files of either naming scheme', () => {
    expect(db).toMatch(/n\.startsWith\(dbBase \+ '\.'\) && n\.endsWith\('\.tmp'\)/);
  });
});
