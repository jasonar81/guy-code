import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const wasm = readFileSync(
  join(process.cwd(), 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
);
const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasm) });
const db = new SQL.Database(new Uint8Array(readFileSync(join(homedir(), '.guycode', 'guycode.db'))));

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

console.log('=== api_keys table ===');
for (const r of rows('SELECT * FROM api_keys')) {
  // mask cipher
  if (r.cipher_b64) r.cipher_b64 = `<${String(r.cipher_b64).length} bytes>`;
  console.log(r);
}

console.log('\n=== api_keys vs usage_events linkage ===');
for (const r of rows(`
  SELECT k.id, k.name, k.is_default,
         COUNT(u.id) AS event_count,
         COALESCE(SUM(u.cost_usd_micros), 0) / 1000000.0 AS total_usd
  FROM api_keys k
  LEFT JOIN usage_events u ON u.api_key_id = k.id
  GROUP BY k.id, k.name, k.is_default
  ORDER BY k.name
`)) {
  console.log(r);
}

console.log('\n=== usage_events with NULL api_key_id ===');
for (const r of rows(`
  SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd_micros), 0) / 1000000.0 AS total_usd
  FROM usage_events
  WHERE api_key_id IS NULL
`)) {
  console.log(r);
}

console.log('\n=== usage_events totals by source ===');
for (const r of rows(`
  SELECT source, api_key_id, COUNT(*) AS n,
         ROUND(SUM(cost_usd_micros) / 1000000.0, 2) AS usd,
         MIN(ts) AS first_ts, MAX(ts) AS last_ts
  FROM usage_events
  GROUP BY source, api_key_id
`)) {
  if (r.first_ts) r.first_ts_iso = new Date(r.first_ts).toISOString();
  if (r.last_ts) r.last_ts_iso = new Date(r.last_ts).toISOString();
  console.log(r);
}

console.log('\n=== budget settings (key_budgets table if exists) ===');
try {
  for (const r of rows('SELECT * FROM key_budgets')) console.log(r);
} catch (e) {
  console.log('  (key_budgets table not found or empty)', e.message);
}

console.log('\n=== budget-relevant settings ===');
for (const r of rows(
  `SELECT key, value FROM settings WHERE key LIKE '%budget%' OR key LIKE '%limit%' OR key LIKE '%cap%' OR key LIKE '%spend%'`
)) {
  console.log(r);
}

console.log('\n=== current-hour and current-day rollups for ALL events ===');
const now = Date.now();
const hourAgo = now - 3600 * 1000;
const dayAgo = now - 24 * 3600 * 1000;
console.log('  events in last 1 hour:');
for (const r of rows(
  `SELECT api_key_id, COUNT(*) AS n, ROUND(SUM(cost_usd_micros) / 1000000.0, 2) AS usd
   FROM usage_events WHERE ts >= ? GROUP BY api_key_id`,
  [hourAgo]
)) {
  console.log('   ', r);
}
console.log('  events in last 24 hours:');
for (const r of rows(
  `SELECT api_key_id, source, COUNT(*) AS n, ROUND(SUM(cost_usd_micros) / 1000000.0, 2) AS usd
   FROM usage_events WHERE ts >= ? GROUP BY api_key_id, source`,
  [dayAgo]
)) {
  console.log('   ', r);
}

db.close();
