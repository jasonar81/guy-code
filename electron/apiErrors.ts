/**
 * Helpers for classifying Anthropic SDK errors into user-facing
 * categories with actionable messages.
 *
 * The SDK exposes errors as `Anthropic.APIError` with a `status`
 * field (4xx / 5xx) and a `message` that is sometimes the raw
 * upstream body, sometimes a synthesized "5xx status code (no body)".
 * Either way the bare `e.message` propagated to the renderer reads
 * like infrastructure plumbing rather than something the user can
 * act on. This module wraps that with phrasing the user can.
 *
 * Categories handled:
 *
 *   • 5xx upstream — Anthropic's server returned a 500/502/503/504.
 *     The SDK has already retried `maxRetries` times by the time we
 *     see it. Tell the user it's transient and to try again.
 *
 *   • 401 / 403 — auth. Either the API key is wrong or the org
 *     doesn't have access to the model. Tell the user to check
 *     their key in Settings.
 *
 *   • 429 — rate limit / quota. Retry-after, slow down.
 *
 *   • 400 — bad request. Sometimes meaningful (we already special-
 *     case "prompt is too long" elsewhere); sometimes a malformed
 *     payload bug on our side. Pass through the upstream message.
 *
 *   • Network / abort — these are handled higher up; we don't
 *     classify them here.
 *
 * The classifier is intentionally lenient — it pattern-matches on
 * the SDK's `status` field AND on substrings of the message string,
 * because some errors (notably "500 status code (no body)") arrive
 * synthesized from the streaming transport rather than from a
 * structured APIError. We accept either path so the user never
 * sees raw plumbing.
 */

/**
 * Public shape returned by `classifyApiError`. The `severity` field
 * is for the renderer to optionally style the error banner — today
 * everything is rendered the same, but transient/actionable
 * distinction is useful and cheap to carry.
 */
export interface ClassifiedApiError {
  /** A short category label, mostly for logging / future telemetry. */
  category: 'upstream-5xx' | 'auth' | 'rate-limit' | 'bad-request' | 'unknown';
  /**
   * `true` when retrying the same request later is likely to succeed.
   * `false` when the user needs to do something (fix their key, shrink
   * the message, etc.) before retrying makes sense.
   */
  transient: boolean;
  /** User-facing message. Never empty. Never starts with raw status numbers. */
  message: string;
  /** Original numeric HTTP status if the error carried one, else null. */
  status: number | null;
}

/**
 * Read a numeric `status` off an unknown error object without throwing.
 * The Anthropic SDK puts it on `e.status` directly. Some transports
 * also put it on `e.response?.status`. Some homemade errors thrown by
 * the SSE adapter put it nowhere — we fall through to message parsing
 * in those cases.
 */
function statusOf(e: unknown): number | null {
  if (!e || typeof e !== 'object') return null;
  const r = e as Record<string, unknown>;
  if (typeof r.status === 'number' && Number.isInteger(r.status)) return r.status;
  const resp = r.response;
  if (
    resp &&
    typeof resp === 'object' &&
    typeof (resp as Record<string, unknown>).status === 'number'
  ) {
    return (resp as Record<string, unknown>).status as number;
  }
  return null;
}

/**
 * Pull the message string off an error in a way that always returns
 * something printable. Empty/missing falls back to a sentinel.
 */
function messageOf(e: unknown): string {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') {
    const m = (e as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  try {
    return String(e);
  } catch {
    return '';
  }
}

/**
 * Pattern-match a 5xx error from either the structured status or
 * the synthesized "<NNN> status code" message form the streaming
 * transport produces when there's no parseable body.
 */
export function is5xxError(e: unknown): boolean {
  const s = statusOf(e);
  if (s != null && s >= 500 && s < 600) return true;
  const m = messageOf(e);
  // Examples we've seen in the wild:
  //   "500 status code (no body)"
  //   "503 Service Unavailable"
  //   "502 Bad Gateway"
  if (/\b5\d\d\s+(status\s+code|service\s+unavailable|bad\s+gateway|gateway\s+timeout|internal\s+server\s+error)\b/i.test(m)) {
    return true;
  }
  return false;
}

/**
 * Classify an error into a user-facing category. The returned
 * `message` is what the renderer should show — it's already
 * phrased as something the user can act on rather than as a raw
 * status code.
 *
 * Examples (with maxRetries=5 already exhausted upstream):
 *   classify({status: 500, message: '500 status code (no body)'})
 *     → category: 'upstream-5xx', transient: true,
 *       message: 'Anthropic API returned a server error (500) after 6 attempts...'
 *
 *   classify({status: 401, message: 'invalid x-api-key'})
 *     → category: 'auth', transient: false,
 *       message: 'API key was rejected (401). Check the key in Settings...'
 *
 * Inputs we don't recognize fall through to category: 'unknown' with
 * the raw message preserved — losing nothing for the user, just
 * not embellishing.
 */
export function classifyApiError(e: unknown): ClassifiedApiError {
  const status = statusOf(e);
  const raw = messageOf(e).trim();

  if (is5xxError(e)) {
    const code = status ?? extractStatusFromMessage(raw) ?? 5;
    return {
      category: 'upstream-5xx',
      transient: true,
      status: typeof code === 'number' && code >= 500 ? code : null,
      message:
        `Anthropic's API returned a server error (${code}) after the client SDK exhausted its retries. ` +
        `This is almost always a transient upstream issue on Anthropic's side, not a problem with your message ` +
        `or this app. Wait a minute or two and try again. ` +
        `If it persists, check https://status.anthropic.com/ for an active incident.`,
    };
  }

  if (status === 401 || status === 403 || /\b401|403\b|invalid\s+(api[\s-]?key|x-api-key)|authentication/i.test(raw)) {
    return {
      category: 'auth',
      transient: false,
      status,
      message:
        `Anthropic rejected the API key (HTTP ${status ?? 'auth'}). Open Settings and re-enter / re-select your key. ` +
        `If you recently rotated the key on Anthropic's dashboard, it may take a few seconds to propagate.`,
    };
  }

  if (status === 429 || /\b429\b|rate\s*limit|too\s+many\s+requests/i.test(raw)) {
    return {
      category: 'rate-limit',
      transient: true,
      status,
      message:
        `Anthropic rate limit hit (HTTP 429). Wait 30 seconds and try again. ` +
        `If this happens repeatedly, your org's tier may need a usage cap raise on the Anthropic dashboard.`,
    };
  }

  if (status === 400 || /\b400\s+/.test(raw)) {
    return {
      category: 'bad-request',
      transient: false,
      status,
      message: raw || 'The request was rejected (400). No further details available.',
    };
  }

  return {
    category: 'unknown',
    transient: false,
    status,
    message: raw || 'Unknown API error (no message).',
  };
}

/**
 * Last-resort: try to dig a 3-digit status out of a free-form
 * message string. Used when the structured `status` is absent but
 * the message clearly carries one (e.g., the SSE transport's
 * "500 status code (no body)" form).
 */
function extractStatusFromMessage(m: string): number | null {
  const match = /\b(5\d\d)\s/.exec(m);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}
