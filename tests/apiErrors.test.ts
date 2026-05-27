/**
 * Tests for `electron/apiErrors.ts` — the user-facing classifier for
 * Anthropic SDK errors.
 *
 * Coverage strategy:
 *   • Every shape of error we've seen surface to users is exercised
 *     directly so we don't regress the user-facing copy.
 *   • The classifier MUST work for both structured APIError objects
 *     (with `.status`) AND for the synthesized message-only form that
 *     the streaming SSE transport produces ("500 status code (no
 *     body)"). Either path was observed by the v0.1.6 user.
 *   • Resulting `message` field must never start with raw status
 *     digits and must always include something the user can act on.
 */
import { describe, expect, it } from 'vitest';
import { classifyApiError, is5xxError } from '../electron/apiErrors';

describe('is5xxError', () => {
  it('matches structured 5xx errors via status field', () => {
    expect(is5xxError({ status: 500, message: 'oops' })).toBe(true);
    expect(is5xxError({ status: 502, message: '' })).toBe(true);
    expect(is5xxError({ status: 503 })).toBe(true);
    expect(is5xxError({ status: 504 })).toBe(true);
    expect(is5xxError({ status: 599 })).toBe(true);
  });

  it('matches the synthesized "5xx status code (no body)" message form', () => {
    // The exact verbatim form the v0.1.6 user saw twice in a row.
    expect(is5xxError({ message: '500 status code (no body)' })).toBe(true);
    expect(is5xxError({ message: '502 status code (no body)' })).toBe(true);
    expect(is5xxError({ message: '503 Service Unavailable' })).toBe(true);
    expect(is5xxError({ message: '504 Gateway Timeout' })).toBe(true);
    expect(is5xxError({ message: '500 Internal Server Error' })).toBe(true);
  });

  it('matches when status field is on response sub-object', () => {
    expect(is5xxError({ response: { status: 500 } })).toBe(true);
  });

  it('does NOT match non-5xx errors', () => {
    expect(is5xxError({ status: 400, message: 'bad request' })).toBe(false);
    expect(is5xxError({ status: 401 })).toBe(false);
    expect(is5xxError({ status: 429 })).toBe(false);
    expect(is5xxError({ message: 'network error' })).toBe(false);
    expect(is5xxError({ message: '' })).toBe(false);
    expect(is5xxError(null)).toBe(false);
    expect(is5xxError(undefined)).toBe(false);
  });

  it('does NOT false-positive on 5xx-looking numbers in unrelated context', () => {
    // E.g. an error message that mentions "500ms timeout" or "500 tokens".
    expect(is5xxError({ message: 'request took 500ms' })).toBe(false);
    expect(is5xxError({ message: 'prompt is 500 tokens' })).toBe(false);
  });
});

describe('classifyApiError — 5xx upstream (the user-reported regression)', () => {
  it('classifies "500 status code (no body)" as transient upstream-5xx', () => {
    const r = classifyApiError({ message: '500 status code (no body)' });
    expect(r.category).toBe('upstream-5xx');
    expect(r.transient).toBe(true);
    expect(r.message).toMatch(/server error/i);
    expect(r.message).toMatch(/transient/i);
    expect(r.message).toMatch(/try again/i);
    // Must NOT start with a raw status digit.
    expect(/^\d{3}/.test(r.message)).toBe(false);
  });

  it('classifies structured 502 the same way', () => {
    const r = classifyApiError({ status: 502, message: 'Bad Gateway' });
    expect(r.category).toBe('upstream-5xx');
    expect(r.transient).toBe(true);
    expect(r.status).toBe(502);
  });

  it('references the status page in the user message', () => {
    const r = classifyApiError({ status: 500 });
    expect(r.message).toContain('status.anthropic.com');
  });

  it('includes the status code in parens so support can ask "which one"', () => {
    const r = classifyApiError({ status: 503 });
    expect(r.message).toMatch(/\(503\)/);
  });
});

describe('classifyApiError — auth', () => {
  it('classifies 401 as auth / non-transient', () => {
    const r = classifyApiError({ status: 401, message: 'invalid x-api-key' });
    expect(r.category).toBe('auth');
    expect(r.transient).toBe(false);
    expect(r.message).toMatch(/api key/i);
    expect(r.message).toMatch(/settings/i);
  });

  it('classifies 403 as auth', () => {
    const r = classifyApiError({ status: 403, message: 'forbidden' });
    expect(r.category).toBe('auth');
    expect(r.transient).toBe(false);
  });

  it('classifies message-only auth errors when status missing', () => {
    const r = classifyApiError({ message: 'authentication failed' });
    expect(r.category).toBe('auth');
  });
});

describe('classifyApiError — rate limit', () => {
  it('classifies 429 as rate-limit / transient', () => {
    const r = classifyApiError({ status: 429, message: 'rate_limit_exceeded' });
    expect(r.category).toBe('rate-limit');
    expect(r.transient).toBe(true);
    expect(r.message).toMatch(/rate limit/i);
    expect(r.message).toMatch(/wait/i);
  });

  it('classifies message-only rate-limit errors', () => {
    const r = classifyApiError({ message: 'too many requests' });
    expect(r.category).toBe('rate-limit');
  });
});

describe('classifyApiError — bad request', () => {
  it('classifies 400 as bad-request / non-transient', () => {
    const r = classifyApiError({ status: 400, message: 'invalid_request_error: foo' });
    expect(r.category).toBe('bad-request');
    expect(r.transient).toBe(false);
    // Bad requests pass through the upstream message — the API
    // usually has something specific to say (missing field, etc.).
    expect(r.message).toContain('invalid_request_error');
  });
});

describe('classifyApiError — unknown', () => {
  it('preserves the raw message for unrecognized errors', () => {
    const r = classifyApiError({ message: 'something weird happened' });
    expect(r.category).toBe('unknown');
    expect(r.message).toBe('something weird happened');
  });

  it('falls back to a sentinel when no message is available', () => {
    const r = classifyApiError({});
    expect(r.message.length).toBeGreaterThan(0);
  });

  it('handles non-object inputs without throwing', () => {
    expect(() => classifyApiError(null)).not.toThrow();
    expect(() => classifyApiError(undefined)).not.toThrow();
    expect(() => classifyApiError('a string error')).not.toThrow();
    expect(() => classifyApiError(42)).not.toThrow();
  });

  it('handles string errors by treating them as messages', () => {
    const r = classifyApiError('something failed');
    expect(r.message).toBe('something failed');
  });
});

describe('classifyApiError — output contract', () => {
  it('always returns a non-empty user-facing message', () => {
    // No matter what we feed in, `message` must not be empty —
    // the renderer displays this directly.
    const inputs: unknown[] = [
      null,
      undefined,
      {},
      { status: 500 },
      { status: 401 },
      { status: 429 },
      { status: 400 },
      { message: '' },
      { message: '500 status code (no body)' },
      'string',
      42,
    ];
    for (const inp of inputs) {
      const r = classifyApiError(inp);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('transient flag is true ONLY for 5xx + 429', () => {
    expect(classifyApiError({ status: 500 }).transient).toBe(true);
    expect(classifyApiError({ status: 429 }).transient).toBe(true);
    expect(classifyApiError({ status: 401 }).transient).toBe(false);
    expect(classifyApiError({ status: 400 }).transient).toBe(false);
    expect(classifyApiError({ message: 'unknown' }).transient).toBe(false);
  });
});
