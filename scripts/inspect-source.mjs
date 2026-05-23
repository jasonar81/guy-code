import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const wasm = readFileSync(
  join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
);
const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasm) });
const path = join(homedir(), '.guycode', 'guycode.db');
const db = new SQL.Database(new Uint8Array(readFileSync(path)));

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

console.log('=== Usage events by source ===');
for (const r of rows(
  `SELECT source, COUNT(*) AS n, MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM usage_events GROUP BY source`
)) {
  console.log(
    `  ${(r.source || 'NULL').padEnd(15)} n=${r.n} first=${new Date(r.first_ts).toISOString()} last=${new Date(r.last_ts).toISOString()}`
  );
}

console.log('\n=== Live usage events by day (Guy-native) ===');
for (const r of rows(
  `SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS n FROM usage_events
   WHERE source = 'live' GROUP BY day ORDER BY day`
)) {
  console.log(`  ${r.day}  ${r.n} events`);
}

console.log('\n=== Sessions in ~/.guycode/sessions vs ~/.claude/projects ===');
for (const r of rows(
  `SELECT
     SUM(CASE WHEN jsonl_path LIKE '%.guycode%' THEN 1 ELSE 0 END) AS guy_native,
     SUM(CASE WHEN jsonl_path LIKE '%.claude%' THEN 1 ELSE 0 END) AS imported,
     COUNT(*) AS total
   FROM sessions`
)) {
  console.log(r);
}

db.close();
