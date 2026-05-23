// Inspect recent usage events to diagnose budget tracking.
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

  // Schema first
  const schema = db.exec(`SELECT sql FROM sqlite_master WHERE name='usage_events'`);
  console.log('Schema:');
  console.log(schema[0]?.values[0]?.[0] ?? '(table missing)');

  // Total counts by source
  const counts = db.exec(
    `SELECT source, COUNT(*) AS n, SUM(cost_usd_micros) AS total FROM usage_events GROUP BY source`
  );
  console.log('\nCount by source:');
  for (const row of counts[0]?.values ?? []) {
    const [source, n, total] = row;
    console.log(`  ${source}: ${n} events, total $${(total / 1_000_000).toFixed(4)}`);
  }

  // Events in the last 12 hours (live only)
  const now = Date.now();
  const since = now - 12 * 60 * 60 * 1000;
  const recent = db.exec(
    `SELECT ts, cost_usd_micros, model, session_id
       FROM usage_events
      WHERE source='live' AND ts >= ${since}
      ORDER BY ts DESC LIMIT 50`
  );
  console.log(`\nLast 50 live events in past 12 hours:`);
  if (!recent[0] || recent[0].values.length === 0) {
    console.log('  (none)');
  } else {
    let sum = 0;
    for (const [ts, cost, model, sid] of recent[0].values) {
      sum += cost;
      console.log(
        `  ${new Date(ts).toLocaleString()}  $${(cost / 1_000_000).toFixed(4).padStart(9)}  ${model}  ${sid.slice(0, 8)}`
      );
    }
    console.log(`  -- ${recent[0].values.length} events, sum $${(sum / 1_000_000).toFixed(4)}`);
  }

  // Bucket by hour for past 12 hours
  console.log('\nSpend per clock-hour bucket (past 12h, live source):');
  for (let i = 0; i < 12; i++) {
    const h = new Date(now);
    h.setMinutes(0, 0, 0);
    h.setHours(h.getHours() - i);
    const from = h.getTime();
    const to = from + 3600_000;
    const r = db.exec(
      `SELECT COALESCE(SUM(cost_usd_micros), 0) AS t, COUNT(*) AS n
         FROM usage_events
        WHERE source='live' AND ts >= ${from} AND ts < ${to}`
    );
    const [total, n] = r[0]?.values?.[0] ?? [0, 0];
    if (n > 0)
      console.log(
        `  ${h.toLocaleString()} → +1h: ${n} events, $${(total / 1_000_000).toFixed(4)}`
      );
  }

  // Look for very recent (last 30 min) events
  const veryRecent = db.exec(
    `SELECT ts, cost_usd_micros, model FROM usage_events
      WHERE source='live' AND ts >= ${now - 30 * 60 * 1000}
      ORDER BY ts ASC`
  );
  console.log('\nEvents in last 30 minutes:');
  if (!veryRecent[0] || veryRecent[0].values.length === 0) {
    console.log('  (none — this matches "current hour shows $0" if the last turn ended >30min ago)');
  } else {
    for (const [ts, cost, model] of veryRecent[0].values) {
      console.log(`  ${new Date(ts).toLocaleString()}  $${(cost / 1_000_000).toFixed(4)}  ${model}`);
    }
  }
})();
