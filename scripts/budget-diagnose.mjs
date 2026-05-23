// Read-only diagnostic: dumps the user's current budget configuration and
// recent live spend so we can see why quotas are getting blown past.
//
// Guy Code uses sql.js (WASM), not better-sqlite3 — but the same DB file
// is plain SQLite, so any reader works. We pull sql.js out of the app's
// own node_modules to avoid adding a top-level dep just for diagnostics.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlJsPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js');
// Windows: ESM dynamic import refuses bare absolute paths ("c:\..."); needs file:// URL.
const initSqlJs = (await import(pathToFileURL(sqlJsPath).href)).default;
const wasmBytes = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
const SQL = await initSqlJs({ wasmBinary: wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) });

const dbPath = path.join(os.homedir(), '.guycode', 'guycode.db');
const sqlBytes = fs.readFileSync(dbPath);
const db = new SQL.Database(sqlBytes);

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

console.log('=== API keys (daily_budget_usd, per_turn_cap_usd) ===');
console.table(query(
  `SELECT id, name, daily_budget_usd AS daily, per_turn_cap_usd AS per_turn,
          is_default, datetime(created_at/1000, 'unixepoch', 'localtime') AS created
     FROM api_keys`
));

console.log('\n=== Global budget settings ===');
console.table(query(`SELECT key, value FROM settings WHERE key LIKE 'budget.%'`));

const startOfDay = new Date();
startOfDay.setHours(0, 0, 0, 0);

console.log('\n=== Today (local) live spend by api_key_id ===');
console.table(query(
  `SELECT COALESCE(api_key_id, '<legacy/null>') AS api_key_id,
          printf('%.2f', SUM(cost_usd_micros)/1e6) AS dollars,
          COUNT(*) AS turns,
          datetime(MIN(ts)/1000, 'unixepoch', 'localtime') AS first,
          datetime(MAX(ts)/1000, 'unixepoch', 'localtime') AS last
     FROM usage_events
    WHERE source = 'live' AND ts >= ?
    GROUP BY api_key_id`,
  [startOfDay.getTime()]
));

console.log('\n=== Live spend per day (last 14 days) ===');
console.table(query(
  `SELECT date(ts/1000, 'unixepoch', 'localtime') AS day,
          printf('%.2f', SUM(cost_usd_micros)/1e6) AS dollars,
          COUNT(*) AS turns
     FROM usage_events
    WHERE source = 'live' AND ts >= ?
    GROUP BY day
    ORDER BY day DESC`,
  [Date.now() - 14 * 24 * 3600 * 1000]
));

console.log('\n=== Top 10 most expensive single events (last 7 days) ===');
// Look up columns dynamically since older DBs may not have cache columns.
const cols = query(`PRAGMA table_info(usage_events)`).map((r) => r.name);
const extraCols = cols.filter((c) => /token|cache/i.test(c)).map((c) => `${c}`);
const extraSql = extraCols.length > 0 ? ', ' + extraCols.join(', ') : '';
console.table(query(
  `SELECT session_id,
          datetime(ts/1000, 'unixepoch', 'localtime') AS at,
          printf('%.2f', cost_usd_micros/1e6) AS dollars${extraSql}
     FROM usage_events
    WHERE source = 'live' AND ts >= ?
    ORDER BY cost_usd_micros DESC
    LIMIT 10`,
  [Date.now() - 7 * 24 * 3600 * 1000]
));

console.log('\n=== Hour-by-hour spend today (default key) ===');
console.table(query(
  `SELECT strftime('%H:00', ts/1000, 'unixepoch', 'localtime') AS hour,
          printf('%.2f', SUM(cost_usd_micros)/1e6) AS dollars,
          COUNT(*) AS turns
     FROM usage_events
    WHERE source = 'live' AND ts >= ?
    GROUP BY hour
    ORDER BY hour`,
  [startOfDay.getTime()]
));

console.log('\n=== Sessions currently sleeping on budget ===');
console.table(query(
  `SELECT id, state,
          (pending_user_text IS NOT NULL) AS has_pending,
          datetime(sleeping_since/1000, 'unixepoch', 'localtime') AS since
     FROM sessions
    WHERE state = 'sleeping-budget'`
));

console.log('\n=== Sessions with sleeping_since set but state != sleeping-budget ===');
console.table(query(
  `SELECT id, state,
          (pending_user_text IS NOT NULL) AS has_pending,
          datetime(sleeping_since/1000, 'unixepoch', 'localtime') AS since
     FROM sessions
    WHERE sleeping_since IS NOT NULL AND state != 'sleeping-budget'`
));
