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
  listSessionsByState,
  setSessionPending,
  getApiKeyRow,
  getDefaultApiKeyRow,
  getSetting,
  getSessionForceContinue,
  setApiKeyBudgetAdjustment,
  resetApiKeyBudgetAdjustment,
  type ApiKeyRow,
} from './db';
import { broadcastAgentEvent } from './agentEvents';
import log from 'electron-log';

const MICROS_PER_USD = 1_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let _resumeTimer: NodeJS.Timeout | null = null;
/**
 * Force-resume grace map: sessionId → epoch-ms timestamp. Until that
 * timestamp, every precheck for the session ALLOWS regardless of
 * spend. Replaces the older one-shot Set semantics: a single bypass
 * just kicked off the next API call, but a turn typically fires many
 * back-to-back calls (tool round-trip, follow-up reasoning, more
 * tool calls), so the agent paused again on call #2 and the user
 * had to spam the button. A time-window grant lets the user hit
 * Force Resume once, get ~60 seconds of progress, and then re-pause
 * cleanly — by which point either the work is done or they have
 * something visible to react to.
 */
const _bypassUntil = new Map<string, number>();

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

// ---- Active-hours window ----------------------------------------------
//
// The user can redistribute the daily budget over a subset of the day
// instead of spreading it evenly over all 24 hours. Stored per-key as
// `(active_hour_start, active_hour_end)` in `api_keys` (added in
// migration v9). Semantics:
//
//   • Both values are hour-of-day integers in [0, 23].
//   • The active set is the half-open interval [start, end) when
//     `start < end`, OR [start, 24) ∪ [0, end) when `start > end`
//     (wraps midnight).
//   • `start == end` (the 0/0 default) means "all 24 hours active" —
//     identical to v0.1.3 behavior.
//   • Inside active hours: base per hour = `daily / activeHoursPerDay`.
//     E.g. daily=$80, window 9..17: base = $80/8 = $10/hr.
//   • Outside active hours: base per hour = 0. The carry-over adjustment
//     still flows through, so banked underspend remains usable.
//
// All math is single-day-local: the user picks hours in their own clock,
// and we use the same local-time hour math that startOfHour already
// uses. No timezone configuration.

/**
 * Pull the configured active-hours window for an API key. Defaults to
 * (0, 0) — all-day — when the key has no override or doesn't exist.
 * The default key is consulted when `apiKeyId` is omitted, matching
 * `getDailyBudgetMicros`.
 */
export function getActiveHoursForKey(apiKeyId?: string | null): {
  start: number;
  end: number;
} {
  const row = apiKeyId ? getApiKeyRow(apiKeyId) : getDefaultApiKeyRow();
  if (!row) return { start: 0, end: 0 };
  // The schema guarantees integers in [0, 23]; defensive clamp in case
  // a legacy migration / direct DB edit ever drifts.
  const clamp = (v: number) => {
    const n = Math.trunc(v ?? 0);
    if (!Number.isFinite(n) || n < 0) return 0;
    if (n > 23) return 23;
    return n;
  };
  return {
    start: clamp(row.active_hour_start),
    end: clamp(row.active_hour_end),
  };
}

/**
 * Count of active hours per day for a given window. Always in [1, 24].
 * Equal start/end (including 0/0) returns 24 — the all-day default.
 * Wraps midnight naturally: 22..6 returns 8 just like 9..17 does.
 */
export function activeHoursPerDay(start: number, end: number): number {
  if (start === end) return 24; // all-day (default or explicit same-value)
  return (end - start + 24) % 24;
}

/**
 * Is the given hour-of-day [0, 23] inside the active window?
 * Half-open: `hour == end` is the FIRST inactive hour.
 */
export function isActiveHourOfDay(
  hour: number,
  start: number,
  end: number
): boolean {
  if (start === end) return true; // all-day
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Wrap: active set is [start, 24) ∪ [0, end).
  return hour >= start || hour < end;
}

/**
 * Is the local clock-hour containing `now` an active hour for the key?
 */
export function isCurrentHourActive(
  apiKeyId?: string | null,
  now: number = Date.now()
): boolean {
  const { start, end } = getActiveHoursForKey(apiKeyId);
  return isActiveHourOfDay(new Date(now).getHours(), start, end);
}

/**
 * Count active hours whose start-of-hour timestamps fall in
 * `[startHourTs, endHourTs)`. Both must be exact hour boundaries
 * (produced by `startOfHour`). Used by `settle()` to compute
 * `total_allowed` across an elapsed range when the window is partial.
 *
 * For the all-day default the math collapses to `elapsed_hours`
 * (no per-hour iteration). For partial windows the function counts
 * full days analytically and walks only the remainder (≤4 weeks of
 * downtime would walk ≤ a day's worth of hours — cheap and exact).
 */
export function countActiveHoursInRange(
  startHourTs: number,
  endHourTs: number,
  start: number,
  end: number
): number {
  if (endHourTs <= startHourTs) return 0;
  const elapsedHours = Math.round((endHourTs - startHourTs) / HOUR_MS);
  if (start === end) return elapsedHours; // all-day
  const perDay = activeHoursPerDay(start, end);
  const fullDays = Math.floor(elapsedHours / 24);
  const remainder = elapsedHours - fullDays * 24;
  // Walk only the remainder. Bounded at < 24 iterations regardless of
  // how long the app was offline.
  let active = fullDays * perDay;
  if (remainder > 0) {
    const firstHour = new Date(startHourTs).getHours();
    for (let i = 0; i < remainder; i++) {
      if (isActiveHourOfDay((firstHour + i) % 24, start, end)) active++;
    }
  }
  return active;
}

/**
 * The base hourly slice in micros = `daily / activeHoursPerDay`.
 *
 * With the all-day default (start == end), this matches v0.1.3's
 * `daily / 24`. With a partial window the budget is REDISTRIBUTED:
 * a key configured 9..17 with $80/day gets $10 base per active hour.
 *
 * Constant given the daily budget AND window settings; does NOT
 * include the carry-over adjustment. For the actual effective cap
 * used by the governor, call `getEffectiveHourCapMicros`.
 */
export function getBaseHourCapMicros(apiKeyId?: string | null): number | null {
  const daily = getDailyBudgetMicros(apiKeyId);
  if (daily == null) return null;
  const { start, end } = getActiveHoursForKey(apiKeyId);
  return Math.floor(daily / activeHoursPerDay(start, end));
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

  // Walk forward. With active-hours redistribution, only ACTIVE hours
  // contribute to `total_allowed` (each at `base` micros); inactive
  // hours contribute 0. Spend in inactive hours is still subtracted —
  // it can only happen via the min-one-call exemption or Force Resume
  // pulling against the banked carry-over, but it counts. Net effect:
  // banked underspend remains usable across inactive periods, and any
  // overspend during an inactive hour shows up as a negative adjustment
  // exactly the same way it would inside the window.
  //
  // `elapsedActive` is an integer count of active hour boundaries; for
  // the all-day default it equals `elapsedHours` (no semantics change).
  const { start, end } = getActiveHoursForKey(row.id);
  const elapsedHours = Math.round(
    (currentHourTs - row.adjustment_hour_ts) / HOUR_MS
  );
  const elapsedActive = countActiveHoursInRange(
    row.adjustment_hour_ts,
    currentHourTs,
    start,
    end
  );
  const totalAllowed = elapsedActive * base + row.adjustment_micros;
  const totalSpent = spendBetween(row.adjustment_hour_ts, currentHourTs, row.id);
  const newAdjustment = totalAllowed - totalSpent;
  setApiKeyBudgetAdjustment(row.id, newAdjustment, currentHourTs);
  log.info(
    `[budget] settled key=${row.id} elapsed=${elapsedHours}h (${elapsedActive} active) allowed=${(totalAllowed / MICROS_PER_USD).toFixed(2)} spent=${(totalSpent / MICROS_PER_USD).toFixed(2)} new_adj=${(newAdjustment / MICROS_PER_USD).toFixed(2)}`
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
  // Outside the active window the per-hour base contribution is 0.
  // The adjustment carry-over still flows through, so a positive
  // banked underspend remains usable (positive effective cap) and an
  // overshoot from a prior active hour stays as a deficit (negative
  // effective cap). All-day windows (start == end, the default) keep
  // the v0.1.3 behavior unchanged.
  const hourContribution = isCurrentHourActive(apiKeyId, now) ? base : 0;
  // Negative effective caps are valid (means "this hour starts with
  // less than zero room" — every call will fail the cap check unless
  // the exemption applies). Floor at the stored value, not at zero.
  return hourContribution + adjustmentMicros;
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

  // Step 1.5. Force-continue mode. The user toggled this session into
  // "ignore budget pauses" mode (right-click → Force continue). Every
  // call is allowed regardless of spend, indefinitely, until they toggle
  // it off. Spend is still recorded by the usage-event path — this only
  // lifts the gate, it does not disable accounting. Distinct from the
  // 60s Force-Resume grace below (which is a one-shot manual nudge).
  if (sessionId && getSessionForceContinue(sessionId)) {
    return {
      allowed: true,
      reason: 'force-continue',
      capMicros: cap,
      spentMicros: currentHourSpendMicros(now, apiKeyId),
      nextRetryTs,
    };
  }

  // Step 2. Force-resume grace window. The user clicked Force Resume,
  // which set `_bypassUntil[sessionId] = now + 60s`. While inside that
  // window, EVERY API call for the session is allowed regardless of
  // spend — so a multi-call turn (model output → tool → tool result
  // → more model output → more tools) doesn't re-pause halfway
  // through. Once the window expires we lazy-clean the entry; a
  // future Force Resume will overwrite it.
  if (sessionId) {
    const until = _bypassUntil.get(sessionId);
    if (until !== undefined) {
      if (now < until) {
        return {
          allowed: true,
          reason: 'force-resume grace',
          capMicros: cap,
          spentMicros: currentHourSpendMicros(now, apiKeyId),
          nextRetryTs,
        };
      }
      // Window expired — clean up so the map doesn't grow unbounded
      // across days of usage. Important for long-running sessions.
      _bypassUntil.delete(sessionId);
      log.info(`[budget] force-resume grace expired for ${sessionId}`);
    }
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
 * Default Force Resume grace window: 60 seconds. Long enough for a
 * realistic agent turn (model output streamed, 1-3 tool round-trips,
 * follow-up model reasoning) to actually finish, short enough that
 * the user doesn't accidentally blow far past the cap if they
 * forgot they clicked Resume. Exported so tests can override.
 */
export const FORCE_RESUME_GRACE_MS = 60_000;

/**
 * Open a 60-second grace window during which every precheck for this
 * session ALLOWS regardless of spend. Wired to the sidebar's "Force
 * resume" button. The window starts at the moment of the call; a
 * second click within an active window REPLACES the timestamp,
 * extending the grace from now (NOT cumulative — we don't want
 * double-clicking to grant 120s of bypass).
 *
 * Why a window and not a one-shot:
 *   A user-visible "turn" is one model output, but under the hood it
 *   may be many discrete API calls — model produces tool_use, agent
 *   runs tool, sends tool_result back, model emits more output, etc.
 *   With a one-shot bypass, only the FIRST of those calls escapes
 *   the budget gate; the second pauses the session again,
 *   immediately, before the user has even seen anything happen.
 *   That's the bug the user reported. A short time window covers
 *   the whole multi-call turn in a single click.
 */
export function setBypassNextTurn(
  sessionId: string,
  graceMs: number = FORCE_RESUME_GRACE_MS,
  now: number = Date.now()
): void {
  _bypassUntil.set(sessionId, now + graceMs);
  log.info(
    `[budget] force-resume grace opened for ${sessionId} (${graceMs}ms)`
  );
}

/**
 * Test/debug helper: read the current grace window expiration for a
 * session, or undefined if no window is active. Not surfaced in the
 * UI; the renderer only ever toggles the button.
 */
export function getBypassUntil(sessionId: string): number | undefined {
  return _bypassUntil.get(sessionId);
}

/**
 * Test helper: clear all grace windows. Used in tests to reset
 * singleton state between runs. Not exported through any module
 * boundary outside tests.
 */
export function _resetBypassForTests(): void {
  _bypassUntil.clear();
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
 *
 * Exported so tests can invoke a single tick directly instead of
 * fighting the `_resumeTimer` interval set up by `startGovernor`.
 */
export async function resumeSweep() {
  const sleepers = listSessionsByState('sleeping-budget');
  if (sleepers.length === 0) return;

  const { runUserTurn } = await import('./agent');

  const now = Date.now();
  for (const s of sleepers) {
    // Defense-in-depth: archived sessions are inert. The archive IPC
    // handler clears pending_user_text and idles them on the way in,
    // so a normal flow would never produce an archived sleeping-budget
    // row. But legacy DBs (archived before this fix) can; the startup
    // resetArchivedRunningSessions sweep cleans them up too. This
    // belt-and-suspenders check guarantees that even if both prior
    // safety nets fail, the sweep refuses to wake an archived row.
    if (s.archived === 1) {
      log.info(
        `[budget] skipping wake of archived session ${s.id}; would have qualified`
      );
      continue;
    }
    const cap = getEffectiveHourCapMicros(s.api_key_id, now);
    let canWake = false;
    if (s.force_continue === 1) {
      // Force-continue mode: wake regardless of bucket state. The precheck
      // will also allow every call, so the resumed turn won't re-pause.
      canWake = true;
    } else if (cap == null) {
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

    // State transition belongs to runUserTurn, not the sweep.
    //
    // Earlier versions of this code did
    //   setSessionState(s.id, 'idle');
    //   broadcastStateChanged(s.id, 'idle');
    // here, BEFORE firing runUserTurn. That created a window where:
    //   • The session shows as `idle` to the renderer for a few
    //     hundred ms (the time between this sync DB write and the
    //     async runUserTurn awakening to set state='running').
    //   • If runUserTurn errored or exited early without work
    //     (the mid-flight pause case where the JSONL is already
    //     drained), state stayed permanently at `idle` — the user
    //     came back to "idle" when they expected to see the original
    //     `sleeping-budget`. The queued message was orphaned.
    //
    // The fix: leave state as `sleeping-budget` until runUserTurn
    // confirms it's actually working. runUserTurn sets state to
    // `running` at line 473 (just before the first stream call), so
    // the success path produces the same UX. If runUserTurn fails or
    // re-blocks immediately (precheckCall says budget is still
    // exhausted), state stays at `sleeping-budget` and the next
    // sweep tick (or user gesture) gets another shot at waking it
    // — which is exactly the desired "comes back exactly as I left
    // it" behavior.
    broadcastAgentEvent({ type: 'budget_woke', sessionId: s.id });

    const pending = s.pending_user_text?.trim();
    if (pending) {
      // Pre-turn pause: never started, fresh user text waiting.
      // Clear the pending marker BEFORE runUserTurn so a re-block
      // inside runUserTurn (precheckCall says budget is gone again
      // on a tight race) doesn't see the stale marker — runUserTurn
      // would itself re-park the text anyway.
      setSessionPending(s.id, null, null);
      log.info(`[budget] auto-resuming ${s.id} with pending message (fresh turn)`);
      runUserTurn({
        sessionId: s.id,
        projectId: s.project_id,
        cwd: s.cwd ?? '',
        userText: pending,
        seedFromJsonl: s.jsonl_path,
      }).catch((e) => {
        log.error(`[budget] auto-resume of ${s.id} failed`, e);
        // runUserTurn rejected before reaching its own state-
        // management code (e.g., a synchronous import / setup
        // throw). Leave state as sleeping-budget AND restore the
        // pending text so the next sweep can retry. Without this
        // restore, the user's queued message is silently dropped.
        try {
          setSessionPending(s.id, pending, Date.now());
        } catch (e2) {
          log.error(
            `[budget] failed to restore pending text after auto-resume failure for ${s.id}`,
            e2
          );
        }
      });
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
      }).catch((e) =>
        log.error(`[budget] auto-resume of ${s.id} failed`, e)
      );
    }
  }
}

export function startGovernor() {
  if (_resumeTimer) return;
  _resumeTimer = setInterval(() => {
    resumeSweep().catch((e) => log.error('[budget] sweep error', e));
    // Sleeping-tool sweep piggybacks on the same cadence. It walks any
    // session in `sleeping-tool` state and either fires the wake (if
    // wake_at_ts is now past) or re-arms the in-process timer (if
    // future). On an idle install this is a no-op SELECT against a
    // tiny set, so adding it to every tick is essentially free.
    void runSleepingToolSweep();
  }, 60_000);
  // Kick once immediately so an app restart doesn't leave paused sessions
  // sitting for up to 60s before the first sweep. The sleeping-tool
  // version is especially important here — a session whose wake_at_ts
  // already passed during the downtime should resume right after
  // boot, not 60 s later.
  resumeSweep().catch((e) => log.error('[budget] startup sweep error', e));
  void runSleepingToolSweep();
  void runWaitingOnSystemResume();
}

/**
 * Lazy wrapper around `wakeSleepingToolSweep` to avoid a static import
 * cycle: `budget.ts` ↔ `agent.ts`. The agent module owns
 * `wakeSleepingTool` / `armWakeTimer`, both of which themselves
 * already pull from `budget.ts` indirectly through `runUserTurn`.
 * Dynamic import lets the modules load in either order.
 */
async function runSleepingToolSweep(): Promise<void> {
  try {
    const { wakeSleepingToolSweep } = await import('./agent');
    await wakeSleepingToolSweep();
  } catch (e) {
    log.error('[budget] sleeping-tool sweep error', e);
  }
}

/**
 * Lazy wrapper around `resumeWaitingOnSystemSessions` (same dynamic-import
 * dance as runSleepingToolSweep). Runs once at startup to resume sessions
 * that were parked in WaitForFile/WaitForProcess/WaitForHttp when the app
 * died — without this they'd come back idle.
 */
async function runWaitingOnSystemResume(): Promise<void> {
  try {
    const { resumeWaitingOnSystemSessions } = await import('./agent');
    await resumeWaitingOnSystemSessions();
  } catch (e) {
    log.error('[budget] waiting-on-system resume error', e);
  }
}

export function stopGovernor() {
  if (_resumeTimer) {
    clearInterval(_resumeTimer);
    _resumeTimer = null;
  }
}
