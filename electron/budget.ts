// Hourly-bucket budget governor.
//
// Model (per the user's spec):
//   • Per API key: `daily_budget_usd` (the human knob).
//   • Hourly cap = `daily_budget / 24`. Buckets are CLOCK-ALIGNED — each
//     bucket runs from the top of one hour to the top of the next (e.g.
//     1:00pm-2:00pm = one bucket).
//   • Pre-flight before every turn:
//        1. Uncapped key → ALLOW.
//        2. force-resume one-shot → ALLOW (consumes the bypass flag).
//        3. `currentHourSpend + inFlightReservation < hourCap` → ALLOW.
//        4. Session has not yet completed a turn in THIS hour → ALLOW
//           (the "min one turn per session per hour" exemption — even
//           with the bucket exhausted, a session that hasn't run yet
//           gets one shot).
//        5. Otherwise → BLOCK; user text gets parked in
//           `sessions.pending_user_text`, session state becomes
//           `sleeping-budget`, retry scheduled for top of next hour.
//   • Resume sweep runs every minute, wakes paused sessions whose
//     bucket has refilled (typically at the top of every clock hour).
//
// Why not rolling 60-min windows? The user explicitly asked for clock-
// aligned buckets — they're easier to reason about (the "1pm bucket"
// is the same number whether you check at 1:01 or 1:59) and they make
// the wake time a clean clock-tick rather than a sliding target.
//
// Why min-one-turn-per-hour? With N sessions running in parallel,
// without an exemption the first session to start in an hour can
// burn the whole bucket and starve every other session for the rest
// of the hour. The exemption is per-session — once a session has
// fired any turn in the current hour bucket, subsequent turns gate
// on the cap normally. So a single key with 10 active sessions can
// burst up to ~$cap + 10×$avg_turn in a worst-case hour, but we
// guarantee progress on every active session.
//
// What's preserved:
//   • Per-key isolation. Spend on key A doesn't gate key B.
//   • In-memory in-flight reservation closes the parallel-precheck race.
//   • `forceResume(sessionId)` one-shot bypass for critical turns.
//   • Persistence across restarts: paused state and pending text live
//     on the session row in SQLite.

import {
  db,
  setSessionState,
  listSessionsByState,
  setSessionPending,
  getApiKeyRow,
  getDefaultApiKeyRow,
  getSetting,
} from './db';
import { broadcastAgentEvent, broadcastStateChanged } from './agentEvents';
import log from 'electron-log';

const MICROS_PER_USD = 1_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/**
 * Conservative reservation for an in-flight turn whose real cost we
 * don't yet have. Sized to a typical single-iteration cost so two
 * sessions that precheck simultaneously when the bucket has $X left
 * can't both pass and collectively spend > $X. Every loop iteration
 * persists its real cost; the reservation only spans the gap between
 * turn-start and the first usage row.
 */
const TURN_RESERVATION_MICROS = 5 * MICROS_PER_USD;

let _resumeTimer: NodeJS.Timeout | null = null;
const _bypassNextTurn = new Set<string>();
/** Per-key in-flight reservation count. Incremented at turn start, decremented at turn end. */
const _inFlight = new Map<string, number>();

// ---- Settings + caps ----------------------------------------------------

/**
 * Daily budget (USD micros) for an API key, or null when uncapped
 * (governor disabled). Resolution order:
 *   1. The api_keys row's `daily_budget_usd` (per-key).
 *   2. Global setting `budget.dailyBudgetUsd` (fallback for keys with no
 *      per-key cap configured).
 *   3. Legacy `budget.rollingHourCapUsd × 24` (pre-multikey schema; kept
 *      so users on older configs aren't suddenly uncapped).
 *   4. null — uncapped.
 */
export function getDailyBudgetMicros(apiKeyId?: string | null): number | null {
  const row = apiKeyId ? getApiKeyRow(apiKeyId) : getDefaultApiKeyRow();
  if (row?.daily_budget_usd != null && row.daily_budget_usd > 0) {
    return Math.round(row.daily_budget_usd * MICROS_PER_USD);
  }
  const raw = getSetting('budget.dailyBudgetUsd');
  if (raw && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n * MICROS_PER_USD);
  }
  const legacy = getSetting('budget.rollingHourCapUsd');
  if (legacy && legacy.trim()) {
    const n = Number(legacy);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 24 * MICROS_PER_USD);
  }
  return null;
}

/**
 * Hourly cap (USD micros) for a key — exactly `daily / 24`. Returns null
 * when the key is uncapped. The clock-hour math is: a $80/day key gets
 * $80/24 ≈ $3.333 per hour. Floor-rounded so we don't accidentally allow
 * $0.0001 over from sub-cent rounding.
 */
export function getHourCapMicros(apiKeyId?: string | null): number | null {
  const daily = getDailyBudgetMicros(apiKeyId);
  if (daily == null) return null;
  return Math.floor(daily / 24);
}

// ---- Time + spend queries ----------------------------------------------

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfHour(ts: number): number {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

function startOfNextHour(ts: number): number {
  return startOfHour(ts) + HOUR_MS;
}

/**
 * Sum of live-source spend in [from, toExclusive), optionally filtered to
 * a single API key. When `apiKeyId` is null/undefined, sums across ALL
 * keys (used by "All keys" aggregated views). When provided, filters to
 * that key only — legacy events with `api_key_id IS NULL` are excluded
 * from per-key totals so a single key's spend isn't inflated by historical
 * un-keyed activity.
 */
function spendBetween(
  from: number,
  toExclusive: number,
  apiKeyId?: string | null
): number {
  if (apiKeyId && apiKeyId.trim()) {
    const r = db()
      .prepare(
        `SELECT COALESCE(SUM(cost_usd_micros), 0) AS total
           FROM usage_events
          WHERE source = 'live' AND ts >= ? AND ts < ? AND api_key_id = ?`
      )
      .get<{ total: number }>(from, toExclusive, apiKeyId);
    return r?.total ?? 0;
  }
  const r = db()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd_micros), 0) AS total
         FROM usage_events
        WHERE source = 'live' AND ts >= ? AND ts < ?`
    )
    .get<{ total: number }>(from, toExclusive);
  return r?.total ?? 0;
}

/** Live spend in the current clock-hour bucket for the given key. */
export function currentHourSpendMicros(
  now: number = Date.now(),
  apiKeyId?: string | null
): number {
  const h = startOfHour(now);
  return spendBetween(h, h + HOUR_MS, apiKeyId);
}

/** Live spend in the current local day for the given key. */
export function todaySpendMicros(
  now: number = Date.now(),
  apiKeyId?: string | null
): number {
  const d = startOfDay(now);
  return spendBetween(d, d + DAY_MS, apiKeyId);
}

/** Rolling 24-hour spend (for the sidebar's "no-budget" fallback display). */
export function rollingDaySpendMicros(
  now: number = Date.now(),
  apiKeyId?: string | null
): number {
  return spendBetween(now - DAY_MS, now, apiKeyId);
}

/**
 * Has session `sessionId` recorded any spend in the current clock-hour
 * bucket? Used by the precheck to grant the min-one-turn-per-session-
 * per-hour exemption: a session that hasn't fired yet this hour gets
 * its first turn even when the bucket is exhausted.
 *
 * We check `usage_events.session_id` rather than turn count because a
 * single turn can produce multiple usage rows (one per loop iteration);
 * any row at all in the bucket means the session has used some budget
 * this hour and the exemption no longer applies.
 */
export function sessionHasTurnInCurrentHour(
  sessionId: string,
  now: number = Date.now()
): boolean {
  const h = startOfHour(now);
  const r = db()
    .prepare(
      `SELECT 1 FROM usage_events
        WHERE session_id = ? AND source = 'live'
          AND ts >= ? AND ts < ?
        LIMIT 1`
    )
    .get(sessionId, h, h + HOUR_MS);
  return !!r;
}

// ---- In-flight reservation ---------------------------------------------

function reservedMicros(apiKeyId: string | null | undefined): number {
  const k = apiKeyId ?? '';
  return (_inFlight.get(k) ?? 0) * TURN_RESERVATION_MICROS;
}

/**
 * Reserve a turn's-worth of budget at turn start. Pair with `noteRunEnd`
 * in a finally block so reservations always release. Without this, two
 * sessions that precheck simultaneously when the bucket has $5 left can
 * both pass and collectively spend $10.
 */
export function noteRunStart(apiKeyId: string | null | undefined): void {
  const k = apiKeyId ?? '';
  _inFlight.set(k, (_inFlight.get(k) ?? 0) + 1);
}

export function noteRunEnd(apiKeyId: string | null | undefined): void {
  const k = apiKeyId ?? '';
  const cur = _inFlight.get(k) ?? 0;
  if (cur <= 1) _inFlight.delete(k);
  else _inFlight.set(k, cur - 1);
}

// ---- Pre-flight ---------------------------------------------------------

interface PrecheckResult {
  allowed: boolean;
  reason: string;
  /** Hourly cap in micros (0 when uncapped). */
  capMicros: number;
  /** Current clock-hour spend (excludes in-flight reservations) in micros. */
  spentMicros: number;
  /** When the user's pending message will be retried automatically (top of next hour). */
  nextRetryTs: number;
}

/**
 * Pre-flight check fired before EVERY turn (initial send and every loop
 * iteration). The five-step decision tree mirrors the comment block at
 * the top of this file. Returns enough detail for the agent to emit a
 * `budget_blocked` event with both the cap and the actual spend so the
 * UI banner can show "this hour: $X / $Y".
 */
export function precheckTurn(
  sessionId?: string,
  apiKeyId?: string | null
): PrecheckResult {
  const now = Date.now();
  const nextRetryTs = startOfNextHour(now);
  const cap = getHourCapMicros(apiKeyId);

  // Step 1: uncapped key → always allow.
  if (cap == null) {
    return { allowed: true, reason: '', capMicros: 0, spentMicros: 0, nextRetryTs };
  }

  // Step 2: force-resume one-shot. Consumed atomically so the next
  // turn after this one will be checked normally.
  if (sessionId && _bypassNextTurn.has(sessionId)) {
    _bypassNextTurn.delete(sessionId);
    log.info(`[budget] bypass consumed for ${sessionId}`);
    return {
      allowed: true,
      reason: 'force-resume bypass',
      capMicros: cap,
      spentMicros: currentHourSpendMicros(now, apiKeyId),
      nextRetryTs,
    };
  }

  const spent = currentHourSpendMicros(now, apiKeyId);
  const reserved = reservedMicros(apiKeyId);

  // Step 3: bucket has room → allow.
  if (spent + reserved < cap) {
    return { allowed: true, reason: '', capMicros: cap, spentMicros: spent, nextRetryTs };
  }

  // Step 4: bucket exhausted, but this session hasn't fired any turn
  // in the current clock hour → grant the min-one-turn exemption. The
  // exemption is checked AFTER the bucket-room check so a session
  // doesn't waste its exemption when there was budget for it anyway.
  if (sessionId && !sessionHasTurnInCurrentHour(sessionId, now)) {
    return {
      allowed: true,
      reason: 'first-turn-this-hour exemption',
      capMicros: cap,
      spentMicros: spent,
      nextRetryTs,
    };
  }

  // Step 5: blocked.
  return {
    allowed: false,
    reason:
      reserved > 0
        ? `hour spend ${(spent / MICROS_PER_USD).toFixed(2)} + in-flight ${(reserved / MICROS_PER_USD).toFixed(2)} ≥ cap ${(cap / MICROS_PER_USD).toFixed(2)}`
        : `hour spend ${(spent / MICROS_PER_USD).toFixed(2)} ≥ cap ${(cap / MICROS_PER_USD).toFixed(2)}`,
    capMicros: cap,
    spentMicros: spent,
    nextRetryTs,
  };
}

// ---- Force resume ------------------------------------------------------

/**
 * Mark a session to bypass the NEXT precheck. One-shot — once consumed,
 * subsequent turns are gated normally. Use sparingly; this is the
 * "I need this critical task done now even though I'm over budget"
 * escape hatch wired to the sidebar's "Force resume" button.
 */
export function setBypassNextTurn(sessionId: string): void {
  _bypassNextTurn.add(sessionId);
}

// ---- Resume sweep ------------------------------------------------------

/**
 * Runs every minute. Walks `sleeping-budget` sessions and wakes any
 * whose hourly bucket has refilled (current hour spend < hourly cap).
 * The typical wake trigger is the top of the next clock hour — when
 * the bucket rolls over, `currentHourSpendMicros` drops to whatever
 * spend has accumulated since the rollover, which is usually 0.
 *
 * Also acts as crash recovery: if the app was closed while paused, the
 * startup tick re-fires any pending text whose bucket now has room.
 */
async function resumeSweep() {
  const sleepers = listSessionsByState('sleeping-budget');
  if (sleepers.length === 0) return;

  const { runUserTurn } = await import('./agent');

  const now = Date.now();
  for (const s of sleepers) {
    const cap = getHourCapMicros(s.api_key_id);
    let canWake = false;
    if (cap == null) {
      canWake = true; // key became uncapped while sleeping
    } else {
      const spent = currentHourSpendMicros(now, s.api_key_id);
      const reserved = reservedMicros(s.api_key_id);
      if (spent + reserved < cap) canWake = true;
      // The min-one-turn exemption ALSO wakes sleepers — if the new
      // hour has rolled over and the session hasn't fired in it, it
      // qualifies for its first turn even if other sessions on the
      // key have already drained the bucket.
      else if (!sessionHasTurnInCurrentHour(s.id, now)) canWake = true;
    }
    if (!canWake) continue;

    setSessionState(s.id, 'idle');
    broadcastStateChanged(s.id, 'idle');
    broadcastAgentEvent({ type: 'budget_woke', sessionId: s.id });
    if (s.pending_user_text && s.pending_user_text.trim()) {
      const pending = s.pending_user_text;
      // Clear pending FIRST so weird timing on the resume can't
      // double-fire the same message.
      setSessionPending(s.id, null, null);
      log.info(`[budget] auto-resuming ${s.id} with pending message`);
      runUserTurn({
        sessionId: s.id,
        projectId: s.project_id,
        cwd: s.cwd ?? '',
        userText: pending,
        seedFromJsonl: s.jsonl_path,
      }).catch((e) => log.error(`[budget] auto-resume of ${s.id} failed`, e));
    }
  }
}

export function startGovernor() {
  if (_resumeTimer) return;
  _resumeTimer = setInterval(() => {
    resumeSweep().catch((e) => log.error('[budget] sweep error', e));
  }, 60_000);
  // Kick once immediately so an app restart doesn't leave paused sessions
  // sitting for up to 60s before the first sweep.
  resumeSweep().catch((e) => log.error('[budget] startup sweep error', e));
}

export function stopGovernor() {
  if (_resumeTimer) {
    clearInterval(_resumeTimer);
    _resumeTimer = null;
  }
}
