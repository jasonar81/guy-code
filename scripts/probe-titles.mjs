import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const dbPath = join(homedir(), '.guycode', 'guycode.db');
const wasmPath = join(REPO_ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

const SQL = await initSqlJs({ wasmBinary: new Uint8Array(readFileSync(wasmPath)) });
const db = new SQL.Database(new Uint8Array(readFileSync(dbPath)));

const probes = [
  'xprof',
  'Xeograph',
  'power iter',
  'power',
  'iteration',
  'Debug and fix CI',
  'Debug and fix',
];

for (const q of probes) {
  const stmt = db.prepare(
    `SELECT id, title, user_title FROM sessions WHERE (title LIKE ? OR user_title LIKE ?) ORDER BY started_at DESC`
  );
  stmt.bind([`%${q}%`, `%${q}%`]);
  const hits = [];
  while (stmt.step()) hits.push(stmt.getAsObject());
  stmt.free();
  console.log(`\n--- "${q}" -> ${hits.length} hits ---`);
  for (const h of hits) console.log(`  ${h.user_title || h.title}`);
}

db.close();
