// Throwaway: find the user's broken session and dump its prefix.
const initSqlJs = require('sql.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const SQL = await initSqlJs({
    locateFile: (f) => path.join('node_modules', 'sql.js', 'dist', f),
  });
  const dbPath = path.join(os.homedir(), '.guycode', 'guycode.db');
  const db = new SQL.Database(fs.readFileSync(dbPath));

  // Find sessions whose ourPath was recently written.
  const sessionsDir = path.join(os.homedir(), '.guycode', 'sessions');
  const ourFiles = fs
    .readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      file: f,
      mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5);

  console.log('Recently modified ourPath files:');
  for (const x of ourFiles) {
    const id = x.file.replace('.jsonl', '');
    const r = db.exec(
      `SELECT jsonl_path, last_message_preview FROM sessions WHERE id = '${id}'`
    );
    console.log(`  ${id} (${new Date(x.mtime).toISOString()})`);
    if (r[0]?.values?.[0]) {
      console.log(`    seed: ${r[0].values[0][0]}`);
      console.log(`    preview: ${r[0].values[0][1]}`);
    }
  }

  // Show the latest ourPath's first ~10 events (post-marker).
  const top = ourFiles[0];
  if (top) {
    console.log('\n--- Top file: first 12 events (filtered to user/assistant) ---');
    const lines = fs
      .readFileSync(path.join(sessionsDir, top.file), 'utf8')
      .split('\n')
      .filter(Boolean);
    let shown = 0;
    for (let i = 0; i < lines.length && shown < 12; i++) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.type !== 'user' && e.type !== 'assistant') continue;
        const role = e.message?.role;
        const blocks = Array.isArray(e.message?.content)
          ? e.message.content.map((b) => {
              if (b.type === 'text') return `text(${b.text?.slice(0, 40) ?? ''}...)`;
              if (b.type === 'tool_use') return `tool_use(${b.name}, id=${b.id})`;
              if (b.type === 'tool_result')
                return `tool_result(id=${b.tool_use_id}, err=${b.is_error ?? false})`;
              return b.type;
            })
          : [`string(${String(e.message?.content).slice(0, 40)}...)`];
        console.log(`  [${i}] ${e.type} role=${role} blocks=[${blocks.join(', ')}]`);
        shown++;
      } catch {}
    }

    // Cross-check pairing across the full file.
    const seenToolUse = new Set();
    const orphans = [];
    let lineIdx = 0;
    for (const ln of lines) {
      lineIdx++;
      try {
        const e = JSON.parse(ln);
        if (e.type !== 'user' && e.type !== 'assistant') continue;
        if (!Array.isArray(e.message?.content)) continue;
        for (const b of e.message.content) {
          if (b.type === 'tool_use' && b.id) seenToolUse.add(b.id);
          if (b.type === 'tool_result' && b.tool_use_id && !seenToolUse.has(b.tool_use_id)) {
            orphans.push({ line: lineIdx, id: b.tool_use_id });
          }
        }
      } catch {}
    }
    console.log(`\nOrphaned tool_results in raw file: ${orphans.length}`);
    if (orphans.length > 0) {
      console.log('First 5:', orphans.slice(0, 5));
    }
  }
})();
