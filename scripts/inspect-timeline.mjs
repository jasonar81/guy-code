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

console.log('=== Earliest and latest usage_events ===');
console.log(
  rows(
    `SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts, COUNT(*) AS n FROM usage_events`
  )
);
const minMax = rows('SELECT MIN(ts) AS a, MAX(ts) AS b FROM usage_events')[0];
console.log(`  earliest: ${new Date(minMax.a).toISOString()}`);
console.log(`  latest:   ${new Date(minMax.b).toISOString()}`);

console.log('\n=== Usage events by day ===');
for (const r of rows(
  `SELECT date(ts/1000, 'unixepoch') AS day, COUNT(*) AS n, SUM(cost_usd_micros)/1000000.0 AS dollars
     FROM usage_events GROUP BY day ORDER BY day`
)) {
  console.log(`  ${r.day}  ${String(r.n).padStart(8)} events  $${r.dollars.toFixed(2)}`);
}

console.log('\n=== Sessions by ended_at day ===');
for (const r of rows(
  `SELECT date(ended_at/1000, 'unixepoch') AS day, COUNT(*) AS n
     FROM sessions WHERE ended_at IS NOT NULL GROUP BY day ORDER BY day`
)) {
  console.log(`  ${r.day}  ${r.n} sessions`);
}

console.log('\n=== imported_files: oldest and newest imported_at ===');
console.log(
  rows(
    `SELECT MIN(imported_at) AS a, MAX(imported_at) AS b, COUNT(*) AS n FROM imported_files`
  )
);
const f = rows(
  `SELECT MIN(imported_at) AS a, MAX(imported_at) AS b FROM imported_files`
)[0];
console.log(`  earliest import: ${new Date(f.a).toISOString()}`);
console.log(`  latest import:   ${new Date(f.b).toISOString()}`);

db.close();
