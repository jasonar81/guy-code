import initSqlJs from 'sql.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

const sessionsDir = join(homedir(), '.guycode', 'sessions');
const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));

console.log(`Found ${files.length} Guy-native JSONL files. Checking DB membership...\n`);

let inDb = 0;
let missing = 0;
for (const f of files) {
  const id = f.replace('.jsonl', '');
  const r = rows(`SELECT id, archived, jsonl_path, message_count FROM sessions WHERE id = ?`, [id]);
  const stat = statSync(join(sessionsDir, f));
  const sizeKB = (stat.size / 1024).toFixed(1);
  if (r.length === 0) {
    console.log(`  MISSING from DB: ${id}  (${sizeKB} KB)`);
    missing++;
  } else {
    const row = r[0];
    console.log(`  in DB: ${id}  arch=${row.archived}  msgs=${row.message_count}  path=${row.jsonl_path}`);
    inDb++;
  }
}

console.log(`\nSummary: ${inDb} in DB, ${missing} MISSING.`);

db.close();
