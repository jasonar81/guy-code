/**
 * Main-process event-loop lag monitor.
 *
 * "(Not Responding)" means the main process stopped pumping its event loop.
 * Rather than keep guessing which code did it, this measures directly: a timer
 * that should fire every `TICK_MS` records how late it actually was. A late
 * tick means something ran long and blocked everything (IPC, window painting,
 * input) for that duration.
 *
 * To attribute the stall to real work, `instrument()` wraps a named operation:
 * whatever is running when a stall is detected gets named in the log. That is
 * the difference between "something blocked for 900ms" and "loadMessages on
 * session abc blocked for 900ms".
 *
 * Cheap enough to leave on: one timer, a counter, and a log line only when a
 * threshold is crossed.
 */
import log from 'electron-log';

const TICK_MS = 250;
/** Only report stalls longer than this (below it, nobody notices). */
const REPORT_MS = 400;

let timer: NodeJS.Timeout | null = null;
let last = 0;
/** Currently-running instrumented operations, newest last. */
const active: Array<{ name: string; started: number }> = [];
/** Worst offenders, by total blocking time attributed to them. */
const tally = new Map<string, { count: number; totalMs: number; worstMs: number }>();

export function startLagMonitor(): void {
  if (timer) return;
  last = Date.now();
  timer = setInterval(() => {
    const now = Date.now();
    const lateBy = now - last - TICK_MS;
    last = now;
    if (lateBy < REPORT_MS) return;
    // Blame the operation that was running (if any) when we stalled.
    const culprit = active.length ? active[active.length - 1].name : '(unattributed)';
    const t = tally.get(culprit) ?? { count: 0, totalMs: 0, worstMs: 0 };
    t.count += 1;
    t.totalMs += lateBy;
    t.worstMs = Math.max(t.worstMs, lateBy);
    tally.set(culprit, t);
    log.warn(
      `[lag] main process blocked ${lateBy}ms during "${culprit}"` +
        (active.length > 1 ? ` (stack: ${active.map((a) => a.name).join(' > ')})` : '')
    );
  }, TICK_MS);
  timer.unref?.();
  log.info('[lag] monitor started');
}

export function stopLagMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Wrap a synchronous operation so a stall during it can be attributed. */
export function instrument<T>(name: string, fn: () => T): T {
  active.push({ name, started: Date.now() });
  try {
    return fn();
  } finally {
    const entry = active.pop();
    // Also report an individual operation that took a long time, even if the
    // sampler happened not to tick during it.
    if (entry) {
      const took = Date.now() - entry.started;
      if (took >= REPORT_MS) {
        log.warn(`[lag] "${name}" took ${took}ms on the main process`);
        const t = tally.get(name) ?? { count: 0, totalMs: 0, worstMs: 0 };
        t.count += 1;
        t.totalMs += took;
        t.worstMs = Math.max(t.worstMs, took);
        tally.set(name, t);
      }
    }
  }
}

/** Same, for async work (measures the whole await, so use sparingly). */
export async function instrumentAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    const took = Date.now() - started;
    if (took >= 2000) log.info(`[lag] async "${name}" took ${took}ms (not necessarily blocking)`);
  }
}

/** A report of what has been blocking, worst first. */
export function lagReport(): Array<{ name: string; count: number; totalMs: number; worstMs: number }> {
  return [...tally.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export function logLagReport(): void {
  const rows = lagReport();
  if (!rows.length) {
    log.info('[lag] no stalls recorded');
    return;
  }
  log.info('[lag] ==== blocking report (worst first) ====');
  for (const r of rows.slice(0, 15)) {
    log.info(
      `[lag]   ${r.name}: ${r.count} stall(s), ${r.totalMs}ms total, ${r.worstMs}ms worst`
    );
  }
}
