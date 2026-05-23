// Recovery: re-ingest Guy-native session JSONLs in ~/.guycode/sessions/
// into the DB after a corruption event wiped session rows + live usage_events.
//
// What this does:
//   - For each ~/.guycode/sessions/<id>.jsonl, parse the events.
//   - upsert a `sessions` row with jsonl_path pointing at the Guy-native
//     copy (overrides any imported row that points at ~/.claude/projects/).
//   - upsert a `projects` row keyed by the cwd embedded in the events (or
//     `__guy_default__` if empty / missing).
//   - INSERT OR IGNORE usage_events from each assistant turn with
//     source='live'. The unique index on (session_id, turn_id) does
//     dedup automatically — idempotent.
//
// Pricing math is duplicated from electron/pricing.ts intentionally so this
// script can run standalone without an Electron environment.
//
// Usage:
//   node scripts/reingest-guy-native.mjs            # dry run
//   node scripts/reingest-guy-native.mjs --apply    # commit changes

import initSqlJs from 'sql.js';
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const apply = process.argv.includes('--apply');
const dbPath = join(homedir(), '.guycode', 'guycode.db');
const sessionsDir = join(homedir(), '.guycode', 'sessions');

if (!existsSync(dbPath)) {
  console.error(`[reingest] DB not found: ${dbPath}`);
  process.exit(1);
}
if (!existsSync(sessionsDir)) {
  console.error(`[reingest] sessions dir not found: ${sessionsDir}`);
  process.exit(1);
}

// ---------- pricing (mirror of electron/pricing.ts) ----------
// Per-MILLION-token USD prices. Verified May 2026.
const PRICES = {
  'claude-opus-4-7': { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  'claude-opus-4-6': { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  'claude-opus-4-5': { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  'claude-opus-4': { input: 15, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30, output: 75 },
  'claude-opus-4-1': { input: 15, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30, output: 75 },
  'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
  'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
  'claude-sonnet-4': { input: 3, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
  'claude-3-5-haiku': { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
};

function priceFor(model) {
  if (!model) return null;
  // Strip date suffix like "-20250506".
  const base = String(model).replace(/-\d{6,8}$/, '');
  return PRICES[base] ?? null;
}

function computeCostMicros(model, t) {
  const p = priceFor(model);
  if (!p) return 0;
  const usd =
    (t.inputTokens * p.input +
      t.cacheReadTokens * p.cacheRead +
      t.cacheWrite5mTokens * p.cacheWrite5m +
      t.cacheWrite1hTokens * p.cacheWrite1h +
      t.outputTokens * p.output) /
    1_000_000;
  return Math.round(usd * 1_000_000);
}

// ---------- DB open ----------
const wasm = readFileSync(join(REPO_ROOT, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
const SQL = await initSqlJs({ wasmBinary: new Uint8Array(wasm) });
const db = new SQL.Database(new Uint8Array(readFileSync(dbPath)));

function rows(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function run(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  while (stmt.step()) {
    /* drain */
  }
  stmt.free();
}

// projectIdFromCwd mirror — simple slug conversion used by Guy Code.
function projectIdFromCwd(cwd) {
  if (!cwd) return '__guy_default__';
  return cwd.replace(/[\\/:]/g, '-');
}

function previewFromContent(content) {
  if (typeof content === 'string') return content.slice(0, 200);
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') return b.text.slice(0, 200);
      if (b?.type === 'tool_use' && b.name) return `[tool_use: ${b.name}]`;
      if (b?.type === 'tool_result' && typeof b.content === 'string')
        return `[tool_result] ${b.content.slice(0, 180)}`;
    }
  }
  return null;
}

function tsToMs(t) {
  if (!t) return null;
  const n = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(n) ? n : null;
}

// ---------- scan files ----------
const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
console.log(`Found ${files.length} Guy-native JSONL files in ${sessionsDir}\n`);

let sessionsUpserted = 0;
let projectsTouched = new Set();
let usageInserted = 0;
let pathsCorrected = 0;
let newSessionRows = 0;

const summary = [];

for (const f of files) {
  const id = f.replace('.jsonl', '');
  const fp = join(sessionsDir, f);
  const stat = statSync(fp);
  let text;
  try {
    text = readFileSync(fp, 'utf8');
  } catch (e) {
    console.warn(`  [skip] ${id}: read failed ${e.message}`);
    continue;
  }

  const lines = text.split('\n');
  let sessionId = id;
  let cwd = '';
  let startedAt = null;
  let endedAt = null;
  let messageCount = 0;
  let lastPreview = null;
  let firstUserPreview = null;
  let aiTitle = null;
  let customTitle = null;
  const turnUsage = []; // {ts, model, turnId, tokens..., costMicros}

  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof evt.sessionId === 'string' && evt.sessionId) sessionId = evt.sessionId;
    if (typeof evt.cwd === 'string' && evt.cwd) cwd = evt.cwd;

    const tsMs = tsToMs(evt.timestamp);
    if (tsMs) {
      if (startedAt === null || tsMs < startedAt) startedAt = tsMs;
      if (endedAt === null || tsMs > endedAt) endedAt = tsMs;
    }

    if (evt.type === 'user' || evt.type === 'assistant') {
      messageCount += 1;
      const p = previewFromContent(evt?.message?.content);
      if (p) lastPreview = p;
      if (evt.type === 'user' && !firstUserPreview && evt?.message?.role === 'user') {
        const c = evt?.message?.content;
        const isToolResultOnly =
          Array.isArray(c) && c.every((b) => b?.type === 'tool_result');
        if (!isToolResultOnly && p) firstUserPreview = p;
      }
    }

    if (evt?.type === 'ai-title' && typeof evt.aiTitle === 'string') aiTitle = evt.aiTitle;
    if (evt?.type === 'custom-title' && typeof evt.customTitle === 'string')
      customTitle = evt.customTitle;

    if (evt.type === 'assistant' && evt.message?.usage) {
      const u = evt.message.usage;
      const inputTokens = u.input_tokens ?? 0;
      const cacheReadTokens = u.cache_read_input_tokens ?? 0;
      const cacheCreateTotal = u.cache_creation_input_tokens ?? 0;
      const cacheCreate1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const cacheCreate5m =
        u.cache_creation?.ephemeral_5m_input_tokens ??
        Math.max(0, cacheCreateTotal - cacheCreate1h);
      const outputTokens = u.output_tokens ?? 0;
      const model = evt.message.model || 'unknown';
      const cost = computeCostMicros(model, {
        inputTokens,
        cacheReadTokens,
        cacheWrite5mTokens: cacheCreate5m,
        cacheWrite1hTokens: cacheCreate1h,
        outputTokens,
      });
      turnUsage.push({
        ts: tsMs ?? Date.now(),
        model,
        turnId: evt.uuid || null,
        inputTokens,
        cacheReadTokens,
        cacheWrite5m: cacheCreate5m,
        cacheWrite1h: cacheCreate1h,
        outputTokens,
        costMicros: cost,
      });
    }
  }

  const projectId = projectIdFromCwd(cwd);
  const title = customTitle || aiTitle || (firstUserPreview ? firstUserPreview.slice(0, 80) : null);

  const existing = rows('SELECT id, jsonl_path, archived FROM sessions WHERE id = ?', [
    sessionId,
  ]);
  const isNew = existing.length === 0;
  if (isNew) newSessionRows += 1;
  else if (existing[0].jsonl_path !== fp) pathsCorrected += 1;

  summary.push({
    id: sessionId,
    file: f,
    sizeKB: (stat.size / 1024).toFixed(1),
    cwd: cwd || '(empty)',
    projectId,
    messageCount,
    title,
    started: startedAt,
    ended: endedAt,
    turns: turnUsage.length,
    cost: turnUsage.reduce((s, t) => s + t.costMicros, 0),
    isNew,
    pathChanged: !isNew && existing[0].jsonl_path !== fp,
    archivedBefore: isNew ? null : existing[0].archived,
  });

  if (apply) {
    // Upsert the project row.
    run(
      `INSERT INTO projects (id, cwd, state, archived, created_at)
       VALUES (?, ?, 'idle', 0, ?)
       ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd`,
      [projectId, cwd, Date.now()]
    );
    projectsTouched.add(projectId);

    // Upsert the session row, REWRITING jsonl_path to the Guy-native
    // location. We deliberately overwrite started_at/ended_at on
    // conflict (the JSONL is authoritative for actual activity timing,
    // not the import-tracker's snapshot).
    run(
      `INSERT INTO sessions
         (id, project_id, jsonl_path, jsonl_mtime, jsonl_size, started_at, ended_at,
          message_count, last_message_preview, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         jsonl_path = excluded.jsonl_path,
         jsonl_mtime = excluded.jsonl_mtime,
         jsonl_size = excluded.jsonl_size,
         started_at = COALESCE(sessions.started_at, excluded.started_at),
         ended_at = excluded.ended_at,
         message_count = excluded.message_count,
         last_message_preview = excluded.last_message_preview,
         title = COALESCE(sessions.title, excluded.title)`,
      [
        sessionId,
        projectId,
        fp,
        stat.mtimeMs,
        stat.size,
        startedAt,
        endedAt,
        messageCount,
        lastPreview,
        title,
      ]
    );
    sessionsUpserted += 1;

    // Insert usage events with source='live'. The unique index
    // (session_id, turn_id) — partial WHERE turn_id IS NOT NULL — gives
    // us idempotency for free; INSERT OR IGNORE skips duplicates.
    for (const t of turnUsage) {
      try {
        run(
          `INSERT OR IGNORE INTO usage_events
             (ts, project_id, session_id, turn_id, model,
              input_tokens, cache_read_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, output_tokens, cost_usd_micros, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
          [
            t.ts,
            projectId,
            sessionId,
            t.turnId,
            t.model,
            t.inputTokens,
            t.cacheReadTokens,
            t.cacheWrite5m,
            t.cacheWrite1h,
            t.outputTokens,
            t.costMicros,
          ]
        );
        usageInserted += 1;
      } catch (e) {
        // Continue on per-turn failures rather than aborting the whole
        // file. A single malformed turn shouldn't block recovery.
        console.warn(`  [warn] insert usage failed for ${sessionId}/${t.turnId}: ${e.message}`);
      }
    }
  }
}

// ---------- print summary ----------
console.log('--- per-file summary ---');
for (const s of summary) {
  const tag = s.isNew ? 'NEW' : s.pathChanged ? 'PATH-FIX' : 'noop';
  const dollars = (s.cost / 1_000_000).toFixed(2).padStart(8);
  const titlePart = s.title ? ` "${s.title.slice(0, 50)}"` : '';
  console.log(
    `  ${tag.padEnd(8)} ${s.id.slice(0, 8)}  msgs=${String(s.messageCount).padStart(6)}` +
      `  turns=${String(s.turns).padStart(4)}  $${dollars}  proj=${s.projectId}${titlePart}`
  );
}

console.log(`\n--- totals ---`);
console.log(`  files scanned:    ${files.length}`);
console.log(`  new session rows: ${newSessionRows}`);
console.log(`  paths corrected:  ${pathsCorrected}`);
console.log(`  total turns:      ${summary.reduce((s, r) => s + r.turns, 0)}`);
console.log(
  `  total cost:       $${(summary.reduce((s, r) => s + r.cost, 0) / 1_000_000).toFixed(2)}`
);
if (apply) {
  console.log(`\n--- writes ---`);
  console.log(`  sessions upserted: ${sessionsUpserted}`);
  console.log(`  projects touched:  ${projectsTouched.size}  (${[...projectsTouched].join(', ')})`);
  console.log(`  usage_events inserted (or skipped as dupes): ${usageInserted}`);
}

if (!apply) {
  console.log('\n[reingest] DRY RUN. Re-run with --apply to commit.');
  db.close();
  process.exit(0);
}

const out = db.export();
writeFileSync(dbPath, Buffer.from(out));
console.log(`\n[reingest] saved DB (${out.length} bytes)`);
db.close();
