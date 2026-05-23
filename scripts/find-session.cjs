// Throwaway: find a session by title substring and dump its recent activity.
const initSqlJs = require('sql.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const needle = (process.argv[2] || 'channel').toLowerCase();
  const SQL = await initSqlJs({
    locateFile: (f) => path.join('node_modules', 'sql.js', 'dist', f),
  });
  const dbPath = path.join(os.homedir(), '.guycode', 'guycode.db');
  const db = new SQL.Database(fs.readFileSync(dbPath));

  const r = db.exec(
    `SELECT id, title, jsonl_path, archived, state, last_message_preview, ended_at, message_count
     FROM sessions
     WHERE LOWER(title) LIKE '%${needle}%'
        OR LOWER(last_message_preview) LIKE '%${needle}%'
     ORDER BY jsonl_mtime DESC
     LIMIT 10`
  );
  if (!r[0]) {
    console.log('No matching sessions.');
    return;
  }
  const cols = r[0].columns;
  for (const row of r[0].values) {
    const obj = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    console.log(JSON.stringify(obj, null, 2));
  }

  // Now look at the ourPath for the first match.
  const id = r[0].values[0][0];
  const ourPath = path.join(os.homedir(), '.guycode', 'sessions', `${id}.jsonl`);
  console.log(`\n--- ourPath events (last 30 user/assistant) for ${id} ---`);
  if (!fs.existsSync(ourPath)) {
    console.log('(ourPath does not exist)');
    return;
  }
  const lines = fs.readFileSync(ourPath, 'utf8').split('\n').filter(Boolean);
  console.log(`Total lines: ${lines.length}`);
  const ua = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.type !== 'user' && e.type !== 'assistant') continue;
      ua.push({ idx: i, evt: e });
    } catch {}
  }
  const tail = ua.slice(-30);
  for (const { idx, evt } of tail) {
    const role = evt.message?.role;
    const blocks = Array.isArray(evt.message?.content)
      ? evt.message.content.map((b) => {
          if (b.type === 'text') return `text(${(b.text ?? '').slice(0, 60).replace(/\n/g, ' ')})`;
          if (b.type === 'tool_use') return `tool_use(${b.name},id=${b.id})`;
          if (b.type === 'tool_result')
            return `tool_result(id=${b.tool_use_id},err=${b.is_error ?? false})`;
          if (b.type === 'thinking') return 'thinking';
          return b.type;
        })
      : [`string(${String(evt.message?.content ?? '').slice(0, 60).replace(/\n/g, ' ')})`];
    console.log(`  [${idx}] ${evt.type}/${role} ts=${evt.timestamp} [${blocks.join(' | ')}]`);
  }
})();
