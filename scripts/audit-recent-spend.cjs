// Audit recent spend to understand where tokens went. Throwaway diagnostic.
// Usage: node scripts/audit-recent-spend.cjs [minutesBack]
//
// What to look for:
//   - cache_write_5m vs cache_write_1h: 5m writes get re-paid every ~7 min.
//     After the 1h-TTL fix lands, you should see 1h writes dominate and the
//     total write volume drop ~70%.
//   - Cache reads should rise relative to fresh input: more cache hits means
//     less re-billing of the conversation history at full input rate.
//   - Output stays the same (no quality impact from these changes).
const initSqlJs = require('sql.js');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const minutesBack = Number(process.argv[2] || 120);
  const SQL = await initSqlJs({
    locateFile: (f) => path.join('node_modules', 'sql.js', 'dist', f),
  });
  const db = new SQL.Database(
    fs.readFileSync(path.join(process.env.USERPROFILE, '.guycode', 'guycode.db'))
  );
  const cutoff = Date.now() - minutesBack * 60 * 1000;

  const totalRow = db.exec(
    `SELECT SUM(cost_usd_micros) AS total_micros,
            COUNT(*) AS calls,
            SUM(input_tokens) AS input_t,
            SUM(cache_read_tokens) AS cache_read_t,
            SUM(cache_write_5m_tokens) AS cache_w5_t,
            SUM(cache_write_1h_tokens) AS cache_w1h_t,
            SUM(output_tokens) AS output_t
       FROM usage_events
      WHERE source='live' AND ts >= ${cutoff}`
  );
  const [tm, n, it, crt, cw5, cw1, ot] = totalRow[0].values[0];
  console.log(`=== Last ${minutesBack} minutes ===`);
  console.log(`Total spend: $${(tm / 1_000_000).toFixed(4)} across ${n} LLM calls`);
  console.log(`Input (uncached, fresh):    ${it.toLocaleString()} tokens`);
  console.log(`Cache reads (cheap):        ${crt.toLocaleString()} tokens`);
  console.log(`Cache writes (5m, expensive): ${cw5.toLocaleString()} tokens`);
  console.log(`Cache writes (1h):           ${cw1.toLocaleString()} tokens`);
  console.log(`Output tokens:              ${ot.toLocaleString()} tokens`);
  console.log('');
  // Cost breakdown at Opus 4.7 pricing
  // input: $5/M, output: $25/M, cache write 5m: $6.25/M, cache write 1h: $10/M, cache read: $0.50/M
  const cost_input = (it * 5) / 1_000_000;
  const cost_cache_read = (crt * 0.5) / 1_000_000;
  const cost_cache_w5 = (cw5 * 6.25) / 1_000_000;
  const cost_cache_w1 = (cw1 * 10) / 1_000_000;
  const cost_output = (ot * 25) / 1_000_000;
  const total_calc = cost_input + cost_cache_read + cost_cache_w5 + cost_cache_w1 + cost_output;
  console.log('Cost breakdown @ Opus 4.7 rates:');
  console.log(`  fresh input:   $${cost_input.toFixed(4)}  (${((cost_input / total_calc) * 100).toFixed(1)}%)`);
  console.log(`  cache reads:   $${cost_cache_read.toFixed(4)}  (${((cost_cache_read / total_calc) * 100).toFixed(1)}%)`);
  console.log(`  cache writes 5m: $${cost_cache_w5.toFixed(4)}  (${((cost_cache_w5 / total_calc) * 100).toFixed(1)}%)`);
  console.log(`  cache writes 1h: $${cost_cache_w1.toFixed(4)}  (${((cost_cache_w1 / total_calc) * 100).toFixed(1)}%)`);
  console.log(`  output:        $${cost_output.toFixed(4)}  (${((cost_output / total_calc) * 100).toFixed(1)}%)`);
  console.log('');

  // Per-session aggregation
  const persess = db.exec(
    `SELECT session_id, COUNT(*) as calls, SUM(cost_usd_micros) as cost_micros,
            SUM(input_tokens) as in_t, SUM(cache_read_tokens) as cr_t,
            SUM(cache_write_5m_tokens) as cw5_t, SUM(output_tokens) as out_t
       FROM usage_events
      WHERE source='live' AND ts >= ${cutoff}
      GROUP BY session_id
      ORDER BY cost_micros DESC`
  );
  console.log('=== Per-session ===');
  for (const v of persess[0]?.values || []) {
    const [sid, calls, cm, in_t, cr_t, cw5_t, out_t] = v;
    console.log(
      `  ${sid.slice(0, 8)}... $${(cm / 1_000_000).toFixed(4)} (${calls} calls) ` +
        `in=${in_t.toLocaleString()} cache_read=${cr_t.toLocaleString()} cache_w5=${cw5_t.toLocaleString()} out=${out_t.toLocaleString()}`
    );
  }
  console.log('');

  // Per-call detail (most expensive 15)
  const calls = db.exec(
    `SELECT ts, session_id, input_tokens, cache_read_tokens,
            cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, cost_usd_micros
       FROM usage_events
      WHERE source='live' AND ts >= ${cutoff}
      ORDER BY cost_usd_micros DESC
      LIMIT 15`
  );
  console.log('=== Top 15 most expensive calls ===');
  console.log('time | sess | fresh_in | cache_read | cache_w5 | cache_w1h | output | cost');
  for (const v of calls[0]?.values || []) {
    const [ts, sid, it, crt, cw5, cw1, ot, cm] = v;
    const t = new Date(ts).toLocaleTimeString();
    console.log(
      `  ${t} ${sid.slice(0, 8)} ${it.toString().padStart(7)} ${crt.toString().padStart(8)} ` +
        `${cw5.toString().padStart(7)} ${cw1.toString().padStart(8)} ${ot.toString().padStart(6)} ` +
        `$${(cm / 1_000_000).toFixed(4)}`
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
