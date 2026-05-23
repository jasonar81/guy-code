// Quick diagnostic: open ~/.guycode/guycode.db read-only and report counts.
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
console.log(`DB file: ${buf.length} bytes`);

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

console.log('\nTables:');
const tables = rows("SELECT name FROM sqlite_master WHERE type='table'");
for (const t of tables) {
  const cnt = rows(`SELECT COUNT(*) AS n FROM "${t.name}"`)[0].n;
  console.log(`  ${t.name.padEnd(20)} ${cnt} rows`);
}

console.log('\nProjects:');
for (const p of rows('SELECT id, cwd FROM projects LIMIT 10')) {
  const cost = rows(
    'SELECT SUM(cost_usd_micros) AS s, COUNT(*) AS n FROM usage_events WHERE project_id = ?',
    [p.id]
  )[0];
  const sessions = rows(
    'SELECT COUNT(*) AS n FROM sessions WHERE project_id = ?',
    [p.id]
  )[0];
  const dollars = ((cost.s || 0) / 1_000_000).toFixed(2);
  console.log(
    `  ${p.id.padEnd(35)} ${sessions.n} sess  ${cost.n} usage  $${dollars}`
  );
}

console.log('\nTop usage events by cost:');
for (const u of rows(
  'SELECT model, SUM(cost_usd_micros) AS s, COUNT(*) AS n FROM usage_events GROUP BY model ORDER BY s DESC'
)) {
  console.log(`  ${u.model.padEnd(40)} ${u.n}   $${(u.s / 1_000_000).toFixed(2)}`);
}

console.log('\nImported file count:');
const ic = rows('SELECT COUNT(*) AS n FROM imported_files')[0];
console.log(`  ${ic.n} files tracked`);

console.log('\nSession sample (first 8 with titles + cost):');
for (const s of rows(
  `SELECT s.id, s.title, s.user_title, s.state, s.message_count, p.cwd,
          COALESCE((SELECT SUM(cost_usd_micros) FROM usage_events u WHERE u.session_id = s.id), 0) AS cost
   FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
   WHERE s.archived = 0
   ORDER BY COALESCE(s.ended_at, s.started_at, 0) DESC
   LIMIT 8`
)) {
  const dollars = ((s.cost || 0) / 1_000_000).toFixed(2).padStart(9);
  const title = (s.user_title || s.title || `(no title) ${s.id.slice(0, 8)}`).padEnd(60).slice(0, 60);
  console.log(`  ${title} | $${dollars} | ${(s.state || 'idle').padEnd(15)}`);
}

console.log('\nTitle backfill stats:');
const tc = rows(
  'SELECT COUNT(*) AS n FROM sessions WHERE title IS NOT NULL AND title != ""'
)[0];
const tnc = rows(
  'SELECT COUNT(*) AS n FROM sessions WHERE title IS NULL OR title = ""'
)[0];
console.log(`  ${tc.n} with title  /  ${tnc.n} without`);
