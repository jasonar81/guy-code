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

console.log('=== ALL settings rows ===');
for (const r of rows('SELECT key, length(value) AS len, substr(value,1,60) AS preview FROM settings')) {
  console.log(`  ${r.key.padEnd(30)} len=${r.len}  preview="${r.preview}"`);
}

db.close();
