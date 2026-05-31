/**
 * Tests for `src/lib/format.ts` — pure formatting helpers used
 * everywhere in the UI. Tight tests so subtle formatting drift gets
 * caught before it ships into a sidebar / pill / banner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatUsdMicros,
  formatTokens,
  truncate,
  relativeTime,
  absoluteTime,
  dateGroupLabel,
  sessionDisplayTitle,
  sessionLastTs,
} from '../src/lib/format';
import type { SessionRow } from '../src/types';

const M = 1_000_000;

afterEach(() => {
  vi.useRealTimers();
});

describe('formatUsdMicros', () => {
  it('formats $1+ to two decimals', () => {
    expect(formatUsdMicros(5 * M)).toBe('$5.00');
    expect(formatUsdMicros(12.34 * M)).toBe('$12.34');
  });

  it('drops decimals at $100+', () => {
    expect(formatUsdMicros(100 * M)).toBe('$100');
    expect(formatUsdMicros(123.45 * M)).toBe('$123');
  });

  it('uses k-suffix at $1000+', () => {
    expect(formatUsdMicros(1000 * M)).toBe('$1.0k');
    expect(formatUsdMicros(2345 * M)).toBe('$2.3k');
  });

  it('shows two decimals for sub-$1 amounts', () => {
    expect(formatUsdMicros(0.05 * M)).toBe('$0.05');
  });

  it('shows four decimals when precise=true and < $1', () => {
    expect(formatUsdMicros(0.0001 * M, { precise: true })).toBe('$0.0001');
  });

  it('returns $0.00 for zero', () => {
    expect(formatUsdMicros(0)).toBe('$0.00');
  });

  it('renders NEGATIVE amounts with a leading minus (carryover deficit)', () => {
    // The budget governor's effective hourly cap goes negative once a key
    // banks overspend; the sidebar shows that deficit honestly. Without sign
    // handling these all fell through to "$0.00".
    expect(formatUsdMicros(-50 * M)).toBe('-$50.00');
    expect(formatUsdMicros(-50.5 * M)).toBe('-$50.50');
    expect(formatUsdMicros(-210.5 * M)).toBe('-$211'); // $100+ drops decimals
    expect(formatUsdMicros(-3200 * M)).toBe('-$3.2k');
    expect(formatUsdMicros(-0.05 * M)).toBe('-$0.05');
  });
});

describe('formatTokens', () => {
  it('returns the integer for < 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(999)).toBe('999');
  });

  it('uses 1.5K format for 1000-9999', () => {
    expect(formatTokens(1000)).toBe('1.0K');
    expect(formatTokens(9500)).toBe('9.5K');
  });

  it('uses K (no decimal) for 10K-999K', () => {
    expect(formatTokens(10_000)).toBe('10K');
    expect(formatTokens(720_000)).toBe('720K');
  });

  it('uses M for ≥1M', () => {
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(10_000_000)).toBe('10M');
  });

  it('handles non-finite/zero gracefully', () => {
    expect(formatTokens(NaN)).toBe('0');
    expect(formatTokens(Infinity)).toBe('0');
    expect(formatTokens(-1)).toBe('0');
  });
});

describe('truncate', () => {
  it('returns string as-is when shorter than n', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates with ellipsis when longer', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
  });

  it('returns empty string for null/undefined', () => {
    expect(truncate(null, 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
  });
});

describe('relativeTime', () => {
  it('returns empty for null/0', () => {
    expect(relativeTime(null)).toBe('');
    expect(relativeTime(0)).toBe('');
  });

  it('shows seconds under 60', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(relativeTime(Date.now() - 30_000)).toBe('30s');
  });

  it('shows minutes 1-59', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5m');
  });

  it('shows hours 1-23', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(relativeTime(Date.now() - 5 * 60 * 60_000)).toBe('5h');
  });

  it('shows days 1-29', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(relativeTime(Date.now() - 7 * 24 * 60 * 60_000)).toBe('7d');
  });
});

describe('absoluteTime', () => {
  it('returns empty for null/0', () => {
    expect(absoluteTime(null)).toBe('');
    expect(absoluteTime(0)).toBe('');
  });

  it("prefixes 'Today' for today's timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    const ts = new Date('2026-05-23T10:30:00').getTime();
    expect(absoluteTime(ts)).toMatch(/^Today /);
  });

  it("prefixes 'Yesterday' for yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    const ts = new Date('2026-05-22T10:30:00').getTime();
    expect(absoluteTime(ts)).toMatch(/^Yesterday /);
  });
});

describe('dateGroupLabel', () => {
  it("returns 'Today' for today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(dateGroupLabel(new Date('2026-05-23T10:00:00').getTime())).toBe('Today');
  });

  it("returns 'Yesterday' for yesterday", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(dateGroupLabel(new Date('2026-05-22T10:00:00').getTime())).toBe('Yesterday');
  });

  it("returns 'N days ago' for 2-6 days back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(dateGroupLabel(new Date('2026-05-20T10:00:00').getTime())).toBe('3 days ago');
  });

  it('returns "Mon DD" for older same-year dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(dateGroupLabel(new Date('2026-01-15T10:00:00').getTime())).toBe(
      'Jan 15'
    );
  });

  it('returns "Mon DD, YYYY" for older different-year dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T13:00:00'));
    expect(dateGroupLabel(new Date('2024-01-15T10:00:00').getTime())).toBe(
      'Jan 15, 2024'
    );
  });

  it("returns 'Unknown' for null", () => {
    expect(dateGroupLabel(null)).toBe('Unknown');
  });
});

describe('sessionDisplayTitle / sessionLastTs', () => {
  function row(overrides: Partial<SessionRow> = {}): SessionRow {
    return {
      id: '12345678-aaaa-bbbb-cccc-deadbeef0001',
      project_id: 'p1',
      jsonl_path: '/tmp/x.jsonl',
      jsonl_mtime: 0,
      jsonl_size: 0,
      cwd: '/tmp',
      title: null,
      user_title: null,
      color: null,
      emoji: null,
      last_message_preview: null,
      state: 'idle',
      started_at: null,
      ended_at: null,
      message_count: 0,
      cost_24h_micros: 0,
      cost_all_time_micros: 0,
      api_key_id: null,
      pending_user_text: null,
      sleeping_since: null,
      archived: 0,
      ...overrides,
    };
  }

  it('prefers user_title when set', () => {
    expect(sessionDisplayTitle(row({ user_title: 'Mine', title: 'Auto' }))).toBe(
      'Mine'
    );
  });

  it('falls back to title when user_title is empty', () => {
    expect(sessionDisplayTitle(row({ user_title: null, title: 'Auto' }))).toBe(
      'Auto'
    );
  });

  it('falls back to last_message_preview, truncated to 80 chars', () => {
    const long = 'x'.repeat(100);
    expect(sessionDisplayTitle(row({ last_message_preview: long }))).toHaveLength(
      80
    );
  });

  it('falls back to "Session XXXXXXXX" when nothing else is set', () => {
    expect(sessionDisplayTitle(row())).toBe('Session 12345678');
  });

  it('sessionLastTs prefers ended_at, then started_at, then null', () => {
    expect(sessionLastTs(row({ ended_at: 100, started_at: 50 }))).toBe(100);
    expect(sessionLastTs(row({ ended_at: null, started_at: 50 }))).toBe(50);
    expect(sessionLastTs(row())).toBe(null);
  });
});
