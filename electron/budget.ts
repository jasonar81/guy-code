// Hourly carry-over budget governor.
//
// The model (per the user's spec, with their worked example):
//
//   • Per API key: `daily_budget_usd` is the human knob.
//   • `base_hourly = daily / 24`. Constant.
//   • Each clock hour starts with an effective cap of
//        effective_cap_for_H = base_hourly + adjustment_as_of_start_of_H
//     where `adjustment` is the signed carry-over from past hours.
//   • At the moment hour H ends and H+1 begins, the new adjustment is:
//        new_adjustment = effective_cap_for_H − spent_in_H
//                       = (base_hourly + old_adjustment) − spent_in_H
//     Positive means we underspent and unused budget rolls forward;
//     negative means we overspent and the next hour's effective cap is
//     reduced by the overage.
//
//   User's example (base=5, starting clean slate):
//     H1: adj=0,  effective=5, spent=7, new_adj = 5 − 7 = −2
//     H2: adj=−2, effective=3, spent=2, new_adj = 3 − 2 = +1
//     H3: adj=+1, effective=6, …
//
// Implementation strategy:
//
//   • Two columns on `api_keys` hold the carry-over state:
//     `adjustment_micros` (signed) and `adjustment_hour_ts` (the start-
//     of-hour the adjustment is "as of"). Updated atomically inside
//     `settle()` on the first budget read in any new hour.
//   • `settle()` walks forward from `adjustment_hour_ts` to the current
//     hour in ONE SQL query. The closed-form math used:
//        elapsed = (current_hour_ts − adjustment_hour_ts) / 1h
//        total_allowed_in_elapsed = elapsed × base_hourly + old_adj
//        total_spent_in_elapsed   = SUM(usage_events in that window)
//        new_adjustment           = total_allowed_in_elapsed − total_spent
//     This is equivalent to iterating hour-by-hour but faster (one query
//     for any number of elapsed hours; matters after the app's been
//     closed for hours/days).
//   • Pre-flight runs BEFORE EVERY API CALL (every `streamMessage` and
//     every subagent round). NOT once per turn. A turn that makes 50
//     calls gets 50 budget checks. This is why we don't need any
//     in-flight reservation: drift can only ever be one call's worth,
//     and the carry-over makes any overrun self-correcting in the next
//     hour.
//   • Min-one-call-per-session-per-hour exemption: if a session has zero
//     rows in `usage_events` for the current hour bucket, its FIRST call
//     in this hour is allowed regardless of cap. After that first call
//     it's gated normally. Guarantees progress across N parallel
//     sessions on the same key.
//   • Reset button (Settings → API key) zeros `adjustment_micros` and
//     re-anchors `adjustment_hour_ts` to the current hour.
//
// What's NOT here (removed deliberately from the prior implementation):
//   • `_inFlight` reservation map. Per-call checking + carry-over
//     handles drift; the reservation was solving a problem the new
//     model doesn't have.
//   • `noteRunStart` / `noteRunEnd` exports. Callers don't need them.

import {
  db,
  setSessionState,
  listSessionsByState,
  setSessionPending,
  getApiKeyRow,
  getDefaultApiKeyRow,
  getSetting,
  setApiKeyBudgetAdjustment,
  resetApiKeyBudgetAdjustment,
  type ApiKeyRow,
} from './db';
import { broadcastAgentEvent, broadcastStateChanged } from './agentEvents';
import log from 'electron-log';

const MICROS_PER_USD = 1_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let _resumeTimer: NodeJS.Timeout | null = null;
const _bypassNextCall = new Set<string>();

// ---- Time helpers -------------------------------------------------------

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

// ---- Budget settings ----------------------------------------------------

/**
 * Daily budget (USD micros) for an API key, or null when uncapped
 * (governor disabled). Resolution order — per-key column, then global
 * setting, then legacy setting × 24 for users on pre-multikey configs.
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
 * The base hourly slice = `daily / 24`. Constant given the daily budget
 * setting; does NOT include the carry-over adjustment. For the actual
 * effective cap used by the governor, call `getEffectiveHourCapMicros`.
 */
export function getBaseHourCapMicros(apiKeyId?: string | null): number | null {
  const daily = getDailyBudgetMicros(apiKeyId);
  if (daily == null) return null;
  return Math.floor(daily / 24);
}

// ---- Spend queries ------------------------------------------------------

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

/** Rolling 24h spend (for the no-budget-set fallback display). */
export function rollingDaySpendMicros(
  now: number = Date.now(),
  apiKeyId?: string | null
): number {
  return spendBetween(now - DAY_MS, now, apiKeyId);
}

/**
 * Has session `sessionId` recorded any spend in the current clock-hour
 * bucket? Used by the precheck to grant the min-one-call-per-session-
 * per-hour exemption. We probe `usage_events.session_id`: any row at all
 * in the bucket means this session has already had its exemption.
 */
export function sessionHasCallInCurrentHour(
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

// ---- Carry-over settlement ---------------------------------------------

/**
 * Settle the carry-over adjustment for a key forward to the current
 * hour, persisting the result. Called on every precheck and budget
 * status read. Idempotent within a single hour bucket — once
 * `adjustment_hour_ts` equals `startOfHour(now)`, settle is a no-op.
 *
 * After app restart (when many hours may have elapsed), settle walks
 * from the stored timestamp to the current hour in a single SQL query
 * using the closed-form math:
 *
 *   elapsed_hours = (current_hour_ts − adjustment_hour_ts) / 1h
 *   total_allowed = elapsed_hours × base + stored_adjustment
 *   total_spent   = SUM(usage_events in [adjustment_hour_ts, current_hour_ts))
 *   new_adj       = total_allowed − total_spent
 *
 * The math is equivalent to iterating hour-by-hour (because each hour's
 * `new_adj = effective_cap − spent_in_hour` chains additively), but
 * does it in O(1) SQL regardless of how long the app was offline.
 *
 * Returns the new `(adjustment_micros, hour_ts)` pair as it now exists
 * in the DB. For uncapped keys (no daily budget set) returns 0/0; the
 * adjustment is meaningless when there's no cap.
 */
function settle(
  row: ApiKeyRow,
  now: number
): { adjustmentMicros: number; hourTs: number } {
  const base = getBaseHourCapMicros(row.id);
  if (base == null) {
    // Uncapped key: no carry-over math to do. Don't touch the columns
    // either — if the user sets a daily budget later, we'll start
    // fresh from the current hour at that moment.
    return {
      adjustmentMicros: row.adjustment_micros,
      hourTs: row.adjustment_hour_ts,
    };
  }
  const currentHourTs = startOfHour(now);

  // Uninitialized (hour_ts == 0): anchor to the current hour with a
  // zero adjustment. This gives every key a clean slate on first read
  // after the v5 migration.
  if (row.adjustment_hour_ts === 0) {
    setApiKeyBudgetAdjustment(row.id, 0, currentHourTs);
    return { adjustmentMicros: 0, hourTs: currentHourTs };
  }

  // Already up-to-date or even ahead (clock-skew defensive): nothing
  // to settle. Returning the stored values keeps the read pure.
  if (row.adjustment_hour_ts >= currentHourTs) {
    return {
      adjustmentMicros: row.adjustment_micros,
      hourTs: row.adjustment_hour_ts,
    };
  }

  // Walk forward. Note: `elapsed` is an integer because both timestamps
  // are exact hour boundaries (we always store `startOfHour(...)`).
  const elapsed = Math.round((currentHourTs - row.adjustment_hour_ts) / HOUR_MS);
  const totalAllowed = elapsed * base + row.adjustment_micros;
  const totalSpent = spendBetween(row.adjustment_hour_ts, currentHourTs, row.id);
  const newAdjustment = totalAllowed - totalSpent;
  setApiKeyBudgetAdjustment(row.id, newAdjustment, currentHourTs);
  log.info(
    `[budget] settled key=${row.id} elapsed=${elapsed}h allowed=${(totalAllowed / MICROS_PER_USD).toFixed(2)} spent=${(totalSpent / MICROS_PER_USD).toFixed(2)} new_adj=${(newAdjustment / MICROS_PER_USD).toFixed(2)}`
  );
  return { adjustmentMicros: newAdjustment, hourTs: currentHourTs };
}

/**
 * Effective cap for the current hour bucket. Calls `settle` first to
 * roll past hours' over/underspend into the adjustment, then returns
 * `base + adjustment`. Returns null when the key is uncapped.
 *
 * Side effect: persists the settled adjustment if it changed. This is
 * fine because settle is idempotent and the cost is one SQL UPDATE on
 * the first read in any new hour.
 */
export function getEffectiveHourCapMicros(
  apiKeyId?: string | null,
  now: number = Date.now()
): number | null {
  const base = getBaseHourCapMicros(apiKeyId);
  if (base == null) return null;
  const row = apiKeyId ? getApiKeyRow(apiKeyId) : getDefaultApiKeyRow();
  if (!row) return base; // shouldn't happen if base is non-null, but defensive
  const { adjustmentMicros } = settle(row, now);
  // Negative effective caps are valid (means "this hour starts with
  // less than zero room" — every call will fail the cap check unless
  // the exemption applies). Floor at the stored value, not at zero.
  return base + adjustmentMicros;
}

/**
 * Back-compat alias for callers that previously asked for "the hour
 * cap". They now want the effective (carry-over-adjusted) cap.
 */
export function getHourCapMicros(apiKeyId?: string | null): number | null {
  return getEffectiveHourCapMicros(apiKeyId);
}

// ---- Pre-flight ---------------------------------------------------------

interface PrecheckResult {
  allowed: boolean;
  reason: string;
  /** Effective hourly cap (base + adjustment) in micros. 0 when uncapped. */
  capMicros: number;
  /** Current clock-hour spend in micros. */
  spentMicros: number;
  /** Top-of-next-hour timestamp the resume sweep will re-evaluate at. */
  nextRetryTs: number;
}

/**
 * Pre-flight check fired BEFORE EVERY ANTHROPIC API CALL. Both the main
 * agent loop and the subagent loop call this on every iteration; not
 * once per turn. The five-step decision tree:
 *
 *   1. Uncapped key → ALLOW.
 *   2. Force-resume one-shot flag set for this session → ALLOW
 *      (consumes the flag).
 *   3. `currentHourSpend < effectiveCap` → ALLOW.
 *   4. Bucket exhausted, but this session has no calls in the current
 *      hour yet → ALLOW with reason `first-call-this-hour exemption`.
 *      (Every session that's trying to make progress gets at least one
 *      API call per hour regardless of cap.)
 *   5. Otherwise → BLOCK; the caller pauses and the resume sweep will
 *      re-check at the top of the next hour.
 */
export function precheckCall(
  sessionId?: string,
  apiKeyId?: string | null,
  now: number = Date.now()
): PrecheckResult {
  const nextRetryTs = startOfNextHour(now);

  // Step 1.
  const cap = getEffectiveHourCapMicros(apiKeyId, now);
  if (cap == null) {
    return { allowed: true, reason: '', capMicros: 0, spentMicros: 0, nextRetryTs };
  }

  // Step 2. One-shot bypass for "Force resume".
  if (sessionId && _bypassNextCall.has(sessionId)) {
    _bypassNextCall.delete(sessionId);
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

  // Step 3. Room in the bucket.
  if (spent < cap) {
    return { allowed: true, reason: '', capMicros: cap, spentMicros: spent, nextRetryTs };
  }

  // Step 4. Min-one-call exemption. The session hasn't burned anything
  // in this hour yet — let it through, even if the bucket is empty or
  // already in the red (cap can be negative if the previous hour
  // overshot by a lot).
  if (sessionId && !sessionHasCallInCurrentHour(sessionId, now)) {
    return {
      allowed: true,
      reason: 'first-call-this-hour exemption',
      capMicros: cap,
      spentMicros: spent,
      nextRetryTs,
    };
  }

  // Step 5. Blocked.
  return {
    allowed: false,
    reason: `hour spend ${(spent / MICROS_PER_USD).toFixed(2)} ≥ effective cap ${(cap / MICROS_PER_USD).toFixed(2)}`,
    capMicros: cap,
    spentMicros: spent,
    nextRetryTs,
  };
}

/**
 * Back-compat alias for callers that imported the old per-turn name.
 * Same behavior; just the function that fires before every API call.
 */
export const precheckTurn = precheckCall;

// ---- Force resume ------------------------------------------------------

/**
 * Mark a session to bypass the NEXT precheck. One-shot — once consumed,
 * subsequent calls are gated normally. Wired to the sidebar's "Force
 * resume" button for the "I need this critical turn done now even
 * though I'm over budget" escape hatch.
 */
export function setBypassNextTurn(sessionId: string): void {
  _bypassNextCall.add(sessionId);
}

// ---- Reset --------------------------------------------------------------

/**
 * Zero out a key's accumulated carry-over and re-anchor it to the
 * current hour. `usage_events` rows are NOT deleted (the historical
 * spend totals stay correct); only the adjustment chain is reset, so
 * the next hour's effective cap is just `base_hourly` again.
 *
 * Used by the Settings "Reset overages/underages" button.
 */
export function resetBudgetAdjustment(apiKeyId: string, now: number = Date.now()): void {
  resetApiKeyBudgetAdjustment(apiKeyId, startOfHour(now));
  log.info(`[budget] reset carry-over adjustment for key=${apiKeyId}`);
}

// ---- Resume sweep ------------------------------------------------------

/**
 * Runs every minute. Walks `sleeping-budget` sessions and wakes any
 * whose hourly bucket has room (or whose min-one-call exemption now
 * applies in the current hour). Typical wake trigger is the top of the
 * next clock hour: settle rolls past spend into the adjustment, the
 * new bucket's spend is 0, and `spent < effectiveCap` becomes true.
 *
 * Two resume modes — the sweep picks the right one per session:
 *
 *   • `pending_user_text` is non-empty → fresh turn. The user typed a
 *     message that was parked (because precheck blocked at the start
 *     of the turn) or accumulated multiple parked messages. Call
 *     `runUserTurn` with that text; it'll append the message to the
 *     JSONL and start the loop.
 *
 *   • `pending_user_text` is empty → mid-flight pause. The agent loop
 *     was in the middle of a turn and the per-call precheck blocked
 *     before the next API call. The JSONL is the source of truth and
 *     already contains everything (user message + intermediate
 *     assistant/tool_result rounds). Call `runUserTurn` with an empty
 *     `userText` AND `continueExisting: true` so it skips appending a
 *     new user message and just re-enters the loop.
 *
 * Also acts as crash recovery: if the app was killed while paused, the
 * startup sweep finds the row and resumes it.
 */
async function resumeSweep() {
  const sleepers = listSessionsByState('sleeping-budget');
  if (sleepers.length === 0) return;

  const { runUserTurn } = await import('./agent');

  const now = Date.now();
  for (const s of sleepers) {
    const cap = getEffectiveHourCapMicros(s.api_key_id, now);
    let canWake = false;
    if (cap == null) {
      canWake = true; // key became uncapped while sleeping
    } else {
      const spent = currentHourSpendMicros(now, s.api_key_id);
      if (spent < cap) canWake = true;
      // The min-one-call exemption ALSO wakes sleepers — if the hour
      // has rolled over and this session hasn't fired in the new
      // bucket, it qualifies even when other sessions on the key have
      // already drained it.
      else if (!sessionHasCallInCurrentHour(s.id, now)) canWake = true;
    }
    if (!canWake) continue;

    setSessionState(s.id, 'idle');
    broadcastStateChanged(s.id, 'idle');
    broadcastAgentEvent({ type: 'budget_woke', sessionId: s.id });

    const pending = s.pending_user_text?.trim();
    if (pending) {
      // Pre-turn pause: never started, fresh user text waiting.
      setSessionPending(s.id, null, null);
      log.info(`[budget] auto-resuming ${s.id} with pending message (fresh turn)`);
      runUserTurn({
        sessionId: s.id,
        projectId: s.project_id,
        cwd: s.cwd ?? '',
        userText: pending,
        seedFromJsonl: s.jsonl_path,
      }).catch((e) => log.error(`[budget] auto-resume of ${s.id} failed`, e));
    } else {
      // Mid-flight pause: JSONL has the truth. Continue without
      // injecting a new user message.
      log.info(`[budget] auto-resuming ${s.id} (continuing in-flight turn)`);
      runUserTurn({
        sessionId: s.id,
        projectId: s.project_id,
        cwd: s.cwd ?? '',
        userText: '',
        continueExisting: true,
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
