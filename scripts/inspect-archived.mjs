// Quick read-only diagnostic: what are the current archived & state counts?
// Verifies whether the user's reported data loss actually exists in the DB.
import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const wasm = readFileSync(
  join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
);
const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasm) });
const path = join(homedir(), '.guycode', 'guycode.db');
const buf = readFileSync(path);
const db = new SQL.Database(new Uint8Array(buf));

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

console.log('=== Archive flag counts ===');
console.log(
  rows(
    `SELECT
       SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN archived IS NULL THEN 1 ELSE 0 END) AS null_archived,
       COUNT(*) AS total
     FROM sessions`
  )
);

console.log('\n=== State counts ===');
for (const r of rows(
  `SELECT state, COUNT(*) AS n FROM sessions GROUP BY state ORDER BY n DESC`
)) {
  console.log(`  ${(r.state ?? 'NULL').padEnd(25)} ${r.n}`);
}

console.log('\n=== Sample of currently-active sessions sorted by activity ===');
for (const r of rows(
  `SELECT id, COALESCE(user_title, title, '(untitled)') AS title,
          archived, state, message_count, ended_at, started_at
     FROM sessions
    ORDER BY COALESCE(ended_at, started_at, 0) DESC
    LIMIT 30`
)) {
  const when = new Date(r.ended_at || r.started_at || 0).toISOString().slice(0, 16);
  const t = String(r.title).padEnd(55).slice(0, 55);
  console.log(`  ${when}  arch=${r.archived}  state=${(r.state ?? 'NULL').padEnd(20)} msgs=${String(r.message_count).padStart(5)}  ${t}`);
}

console.log('\n=== api_keys table ===');
console.log(rows(`SELECT * FROM api_keys`));

console.log('\n=== schema_version ===');
console.log(rows(`SELECT * FROM schema_version ORDER BY version`));

console.log('\n=== Legacy settings still present? ===');
console.log(
  rows(
    `SELECT key, length(value) AS len FROM settings WHERE key LIKE 'apiKey%' OR key LIKE 'budget.%' OR key = 'model'`
  )
);

db.close();
