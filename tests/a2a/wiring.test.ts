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
import { A2A_SCHEMA_SQL, applyA2AP2Schema } from '../../electron/a2a/schema';

const root = join(__dirname, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

describe('A2A wiring', () => {
  it('db.ts applies the shared A2A schema as numbered migrations (v14 tables, v15 guarded P2 columns)', () => {
    const db = src('electron/db.ts');
    expect(db).toMatch(/import \{ A2A_SCHEMA_SQL, applyA2AP2Schema \} from '\.\/a2a\/schema'/);
    expect(db).toMatch(/version: 14,[\s\S]{0,800}up: A2A_SCHEMA_SQL/);
    expect(db).toMatch(/version: 15,[\s\S]{0,600}applyA2AP2Schema\(/);
    // ALTER TABLE is not idempotent: v15 must go through the PRAGMA guard, not raw SQL.
    expect(db).not.toMatch(/ALTER TABLE sessions ADD COLUMN wait_a2a/);
  });

  it('the P2 column migration is idempotent and adds sessions.wait_a2a', async () => {
    const { default: initSqlJs } = await import('sql.js');
    const SQL = await initSqlJs();
    const d = new SQL.Database();
    d.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, archived INTEGER DEFAULT 0)');
    d.exec(A2A_SCHEMA_SQL);
    const cols = (t: string) => {
      const r = d.exec(`PRAGMA table_info(${t})`);
      return r.length ? r[0].values.map((v) => String(v[1])) : [];
    };
    applyA2AP2Schema((q) => d.exec(q), cols);
    applyA2AP2Schema((q) => d.exec(q), cols); // second run must be a no-op, not "duplicate column"
    expect(cols('sessions')).toContain('wait_a2a');
    expect(cols('a2a_tasks')).toEqual(expect.arrayContaining(['push_token_hash', 'approval']));
    expect(cols('a2a_outbox')).toEqual(expect.arrayContaining(['task_id', 'created_ts', 'expires_ts']));
    // Still no plaintext token column for push configs' tokens: `token` exists from P1 but is never written.
    expect(A2A_SCHEMA_SQL).not.toMatch(/push_token TEXT/);
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

  it('exposes the P2 tool set, with natural-language triggers in the descriptions', () => {
    expect(Object.keys(A2A_TOOLS).sort()).toEqual(['A2ACancel', 'A2APair', 'A2APeers', 'A2AReply', 'A2ARequest', 'A2ASend', 'A2ATasks', 'WaitForA2A']);
    expect(A2A_TOOLS.A2ASend.schema.description).toMatch(/tell Dylan's agent/);
    expect(A2A_TOOLS.A2ARequest.schema.description).toMatch(/ask Dylan's agent/);
    expect(A2A_TOOLS.A2ARequest.schema.description).toMatch(/tell us when/);
    expect(A2A_TOOLS.WaitForA2A.schema.description).toMatch(/zero cost/);
    expect(A2A_TOOLS.A2APair.schema.description).toMatch(/pair with/);
    for (const t of Object.values(A2A_TOOLS)) expect(t.schema.description).not.toMatch(/\u2014/); // no em dashes
  });

  it('agent.ts mirrors wait_condition for wait_a2a: timer branch, cancel on a new turn, cancel on Stop', () => {
    const agent = src('electron/agent.ts');
    expect(agent).toMatch(/const waitA2A = getSessionWaitA2A\(sessionId\);[\s\S]{0,400}a2aTimerWake/);
    expect(agent).toMatch(/new turn for \$\{sessionId\} cancelled a pending WaitForA2A/);
    expect(agent).toMatch(/setSessionWaitA2A\(sessionId, null\); \/\/ \.\.\. and any WaitForA2A/);
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

  it('without the UI confirm hook (headless), the model cannot escalate trust through A2APair', async () => {
    // Refused up front, before the A2A node is even looked up, so this runs
    // without Electron or a server.
    for (const trust of ['collaborate', 'full']) {
      const r = await A2A_TOOLS.A2APair.execute({ action: 'trust', peer: 'dylan', trust }, { sessionId: 's', cwd: '' });
      expect(r).toMatch(/needs your user to confirm it in the Guy Code UI/);
    }
  });
});
