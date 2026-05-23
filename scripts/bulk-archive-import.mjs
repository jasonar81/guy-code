// One-shot: archive every session NOT in the user-specified keep list.
//
// Reads the keep-list from screenshots taken in Claude Code on 2026-05-21.
// Matches by case-insensitive PREFIX against `user_title || title`. Truncated
// names from the screenshot still work because we prefix-match.
//
// Usage (with dev server STOPPED):
//   node scripts/bulk-archive-import.mjs           # dry run
//   node scripts/bulk-archive-import.mjs --apply   # commit changes

import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// Captured verbatim from the user's screenshots (Image 1 + Image 2).
// These are PREFIXES; case-insensitive starts-with match against the
// session's displayed title (`user_title || title`).
const KEEP_PATTERNS = [
  // From screenshot — Claude UI label first, with the matching DB title below
  // it when Claude shows a cloud-only rename that isn't in the JSONL.
  'BALD/MARVIN Fixes',
  'Debug and fix CI failures in PR',              // 1st of two screenshot entries
  'Debug and fix failing PR',                      // 2nd entry, actually "Debug and fix failing PR #48164"
  'External Tables',
  'Demo Builder',
  'Channel Factory',
  'Agentic Test Selection',
  'Agent Fleet Mgmt',
  'BALD/MARVIN Testing',
  'ML Model Expansion',
  'Temp tables',
  'Review tensor database project mat',           // truncated -> "...materials"
  'Book Review',
  'Implement Xeograph xprof enhance',             // truncated -> "...enhancement requests"
  'FFT',
  'RLE + Grouped Limit',
  'Matrix Math',
  'WLM Improvements',
  'BLAS',
  'Model call scalar function',
  'Import/export',
  'GQL',
  'Vectorizing expressions',
  'CREATE DATA TYPE',
  'JSON functions',
  'Electronics Design',
  // Cloud-only renames in Claude — fall back to the underlying DB title:
  'Set up xprof capture for Boggle performance',  // shown in Claude as "Update xprof from Xeograph reposi..."
  'Investigate PIC clustering non-determinism',   // shown in Claude as "Investigate CI failure in power iterat..."
];

const apply = process.argv.includes('--apply');

const dbPath = join(homedir(), '.guycode', 'guycode.db');
if (!existsSync(dbPath)) {
  console.error(`[bulk-archive] DB not found: ${dbPath}`);
  process.exit(1);
}

const wasmPath = join(REPO_ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
if (!existsSync(wasmPath)) {
  console.error(`[bulk-archive] sql-wasm.wasm not found: ${wasmPath}`);
  process.exit(1);
}

const SQL = await initSqlJs({ wasmBinary: new Uint8Array(readFileSync(wasmPath)) });
const dbBytes = new Uint8Array(readFileSync(dbPath));
const db = new SQL.Database(dbBytes);

// Collect all sessions.
const rows = [];
{
  const stmt = db.prepare(`SELECT id, title, user_title, archived FROM sessions`);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
}

const lower = (s) => (s == null ? '' : String(s)).toLowerCase().trim();
const patterns = KEEP_PATTERNS.map(lower);

const displayOf = (r) => r.user_title || r.title || '';
const wantKeep = (r) => {
  const d = lower(displayOf(r));
  if (!d) return false;
  return patterns.some((p) => d.startsWith(p));
};

const toArchive = [];          // currently active, will archive
const toUnarchive = [];        // currently archived but in keep list -> unarchive
const matchedAlreadyActive = []; // matched + already active (no-op)
const unmatchedAlreadyArchived = []; // not matched + already archived (no-op)

for (const r of rows) {
  const keep = wantKeep(r);
  if (keep) {
    if (r.archived) toUnarchive.push(r);
    else matchedAlreadyActive.push(r);
  } else {
    if (r.archived) unmatchedAlreadyArchived.push(r);
    else toArchive.push(r);
  }
}

console.log(`Total sessions: ${rows.length}`);
console.log(`Will archive (active -> archived): ${toArchive.length}`);
console.log(`Will unarchive (archived -> active): ${toUnarchive.length}`);
console.log(`Already-active matches (no-op): ${matchedAlreadyActive.length}`);
console.log(`Already-archived non-matches (no-op): ${unmatchedAlreadyArchived.length}`);

console.log('\n--- Pattern -> matches ---');
let unmatchedPatterns = [];
for (const p of KEEP_PATTERNS) {
  const lp = lower(p);
  const hits = rows.filter((r) => lower(displayOf(r)).startsWith(lp));
  console.log(
    `  "${p}" -> ${hits.length}` +
      (hits.length ? `: ${hits.map((h) => `"${displayOf(h)}"`).join(', ')}` : ' [NO MATCH]')
  );
  if (hits.length === 0) unmatchedPatterns.push(p);
}

if (unmatchedPatterns.length) {
  console.log('\n⚠ Patterns with NO matches in DB:');
  for (const p of unmatchedPatterns) console.log(`  - "${p}"`);
}

if (toArchive.length <= 30) {
  console.log('\n--- Sample of sessions to ARCHIVE ---');
  for (const r of toArchive.slice(0, 20)) console.log(`  archive: "${displayOf(r)}"`);
} else {
  console.log(`\n--- First 20 sessions to ARCHIVE (of ${toArchive.length}) ---`);
  for (const r of toArchive.slice(0, 20)) console.log(`  archive: "${displayOf(r)}"`);
}

if (toUnarchive.length) {
  console.log('\n--- Sessions to UNARCHIVE ---');
  for (const r of toUnarchive) console.log(`  unarchive: "${displayOf(r)}"`);
}

if (!apply) {
  console.log('\n[bulk-archive] DRY RUN. Re-run with --apply to commit.');
  db.close();
  process.exit(0);
}

console.log('\n[bulk-archive] Applying changes...');
{
  const archiveStmt = db.prepare(`UPDATE sessions SET archived = 1 WHERE id = ?`);
  for (const r of toArchive) archiveStmt.run([r.id]);
  archiveStmt.free();

  const unarchiveStmt = db.prepare(`UPDATE sessions SET archived = 0 WHERE id = ?`);
  for (const r of toUnarchive) unarchiveStmt.run([r.id]);
  unarchiveStmt.free();
}

const out = db.export();
writeFileSync(dbPath, Buffer.from(out));
console.log(`[bulk-archive] Saved DB (${out.length} bytes). Archived ${toArchive.length}, unarchived ${toUnarchive.length}.`);
db.close();
