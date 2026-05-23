// Find imported sessions whose ourPath does NOT yet exist (haven't been
// opened in Guy yet). Verify the seed file has actual content.
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

  // Sessions whose source path is in ~/.claude/ (imported) AND archived=0.
  const r = db.exec(
    `SELECT id, title, jsonl_path, message_count, archived
     FROM sessions
     WHERE jsonl_path LIKE '%.claude%'
     ORDER BY jsonl_mtime DESC
     LIMIT 30`
  );

  if (!r[0]) {
    console.log('No imported sessions.');
    return;
  }

  const sessionsDir = path.join(os.homedir(), '.guycode', 'sessions');

  for (const row of r[0].values) {
    const [id, title, jsonl_path, message_count, archived] = row;
    const ourPath = path.join(sessionsDir, `${id}.jsonl`);
    const ourExists = fs.existsSync(ourPath);
    const seedExists = fs.existsSync(jsonl_path);
    const seedSize = seedExists ? fs.statSync(jsonl_path).size : 0;
    const ourSize = ourExists ? fs.statSync(ourPath).size : 0;

    console.log(
      `${archived ? '[A]' : '[ ]'} ${id.slice(0, 8)} ` +
        `seed=${seedExists ? `${(seedSize / 1024).toFixed(1)}KB` : 'MISSING'} ` +
        `ours=${ourExists ? `${(ourSize / 1024).toFixed(1)}KB` : 'NONE'} ` +
        `msgs=${message_count} — ${title}`
    );
  }

  console.log(`\nTotal imported: ${r[0].values.length}`);
  console.log(`Imported with ours= NONE: ${r[0].values.filter((row) => !fs.existsSync(path.join(sessionsDir, `${row[0]}.jsonl`))).length}`);
})();
