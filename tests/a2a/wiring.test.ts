// @vitest-environment node
/**
 * App wiring that cannot be exercised without Electron, pinned at the source
 * level (the same approach as perfIndexes.test.ts): the migration applies the
 * shared schema, the tools are registered and hidden while A2A is off, and
 * the A2A surface stays default-off and inform-only in P1.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { A2A_TOOLS } from '../../electron/a2aTools';
import { A2A_SCHEMA_SQL } from '../../electron/a2a/schema';

const root = join(__dirname, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

describe('A2A wiring', () => {
  it('db.ts applies the shared A2A schema as a numbered migration', () => {
    const db = src('electron/db.ts');
    expect(db).toMatch(/import \{ A2A_SCHEMA_SQL \} from '\.\/a2a\/schema'/);
    expect(db).toMatch(/version: 14,[\s\S]{0,800}up: A2A_SCHEMA_SQL/);
  });

  it('the schema stores token refs and hashes, never a plaintext token column', () => {
    expect(A2A_SCHEMA_SQL).toMatch(/token_out_ref TEXT/);
    expect(A2A_SCHEMA_SQL).toMatch(/token_in_hash TEXT/);
    expect(A2A_SCHEMA_SQL).toMatch(/secret_hash TEXT NOT NULL/);
    // Every statement is idempotent.
    const creates = A2A_SCHEMA_SQL.match(/CREATE (TABLE|INDEX)/g) ?? [];
    const ifNot = A2A_SCHEMA_SQL.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) ?? [];
    expect(creates.length).toBe(ifNot.length);
  });

  it('exposes exactly the P1 tools, with natural-language triggers in the descriptions', () => {
    expect(Object.keys(A2A_TOOLS).sort()).toEqual(['A2APair', 'A2APeers', 'A2ASend']);
    expect(A2A_TOOLS.A2ASend.schema.description).toMatch(/tell Dylan's agent/);
    expect(A2A_TOOLS.A2APair.schema.description).toMatch(/pair with/);
    for (const t of Object.values(A2A_TOOLS)) expect(t.schema.description).not.toMatch(/\u2014/); // no em dashes
  });

  it('tools.ts registers them but hides them from the model while a2a.enabled is off', () => {
    const tools = src('electron/tools.ts');
    expect(tools).toMatch(/\.\.\.A2A_TOOLS,/);
    expect(tools).toMatch(/getSetting\('a2a\.enabled'\) === '1'/);
    expect(tools).toMatch(/\.filter\(\(\[name\]\) => a2aOn \|\| !\(name in A2A_TOOLS\)\)/);
  });

  it('main.ts starts and stops A2A; preload and the renderer type agree', () => {
    expect(src('electron/main.ts')).toMatch(/m\.startA2A\(\)/);
    expect(src('electron/main.ts')).toMatch(/m\.stopA2A\(\)/);
    expect(src('electron/preload.ts')).toMatch(/ipcRenderer\.invoke\('a2a:status'\)/);
    expect(src('src/types.ts')).toMatch(/a2a: \{\s*status: \(\) => Promise/);
  });

  it('the model cannot escalate trust through A2APair in P1', async () => {
    // Refused up front, before the A2A node is even looked up, so this runs
    // without Electron or a server.
    for (const trust of ['collaborate', 'full']) {
      const r = await A2A_TOOLS.A2APair.execute({ action: 'trust', peer: 'dylan', trust }, { sessionId: 's', cwd: '' });
      expect(r).toMatch(/needs your user to confirm it in the Guy Code UI/);
    }
  });
});
