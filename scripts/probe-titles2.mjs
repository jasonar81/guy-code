import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SQL = await initSqlJs({
  wasmBinary: new Uint8Array(readFileSync(join(REPO_ROOT, 'node_modules/sql.js/dist/sql-wasm.wasm'))),
});
const db = new SQL.Database(
  new Uint8Array(readFileSync(join(homedir(), '.guycode/guycode.db')))
);

const queries = [
  ['exact-match Debug+fix...PR (count)',
    `SELECT id, title, user_title, started_at FROM sessions WHERE LOWER(COALESCE(user_title, title)) = 'debug and fix ci failures in pr' ORDER BY started_at DESC`],
  ['CI failures broad',
    `SELECT id, title FROM sessions WHERE COALESCE(user_title, title) LIKE '%CI fail%' ORDER BY started_at DESC LIMIT 20`],
  ['Update xprof variants',
    `SELECT id, title FROM sessions WHERE COALESCE(user_title, title) LIKE '%Update%' AND (COALESCE(user_title, title) LIKE '%xprof%' OR COALESCE(user_title, title) LIKE '%Xeograph%') LIMIT 20`],
  ['anything mentioning power',
    `SELECT id, title FROM sessions WHERE COALESCE(user_title, title) LIKE '%power%' ORDER BY started_at DESC LIMIT 20`],
  ['most recent 25 sessions',
    `SELECT id, title, started_at FROM sessions ORDER BY COALESCE(ended_at, started_at) DESC LIMIT 25`],
];

for (const [name, sql] of queries) {
  console.log(`\n--- ${name} ---`);
  const stmt = db.prepare(sql);
  while (stmt.step()) {
    const r = stmt.getAsObject();
    const t = r.user_title || r.title;
    console.log(`  [${r.id?.slice?.(0, 8) ?? ''}] ${t}`);
  }
  stmt.free();
}
db.close();
