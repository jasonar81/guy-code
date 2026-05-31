import type { SessionRow } from '@/types';

const MICROS_PER_DOLLAR = 1_000_000;

export function formatUsdMicros(micros: number, opts?: { precise?: boolean }): string {
  // Handle negatives explicitly. Negative amounts occur for the budget
  // governor's EFFECTIVE hourly cap, which goes below zero once a key has
  // banked overspend (a carry-over deficit). The sidebar shows that deficit
  // honestly (e.g. "-$210.50"); without sign handling a negative value fell
  // through every threshold below and rendered as "$0.00", hiding it.
  const neg = micros < 0;
  const sign = neg ? '-' : '';
  const dollars = Math.abs(micros) / MICROS_PER_DOLLAR;
  if (dollars >= 1000) return `${sign}$${(dollars / 1000).toFixed(1)}k`;
  if (dollars >= 100) return `${sign}$${dollars.toFixed(0)}`;
  if (dollars >= 1) return `${sign}$${dollars.toFixed(2)}`;
  if (opts?.precise) return `${sign}$${dollars.toFixed(4)}`;
  if (dollars > 0) return `${sign}$${dollars.toFixed(2)}`;
  return '$0.00';
}

export function sessionDisplayTitle(s: SessionRow): string {
  if (s.user_title && s.user_title.trim()) return s.user_title;
  if (s.title && s.title.trim()) return s.title;
  if (s.last_message_preview && s.last_message_preview.trim()) {
    return s.last_message_preview.slice(0, 80);
  }
  return `Session ${s.id.slice(0, 8)}`;
}

export function relativeTime(ts: number | null): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Absolute timestamp formatted for tooltips. Returns "Today 10:23 AM" or
 * "May 18 10:23 AM" or "May 18, 2024 10:23 AM" depending on age.
 */
export function absoluteTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((today - dDay) / dayMs);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${diffDays} days ago, ${time}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${time}`;
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** Group label for date-banding sessions. Mirrors Claude's grouping style. */
export function dateGroupLabel(ts: number | null): string {
  if (!ts) return 'Unknown';
  const now = new Date();
  const d = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((today - dDay) / dayMs);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  // Within current year: "May 18". Older: "May 18, 2024".
  if (d.getFullYear() === now.getFullYear()) {
    return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function sessionLastTs(s: SessionRow): number | null {
  return s.ended_at ?? s.started_at ?? null;
}

/**
 * Compact token count: 12 → "12", 9_500 → "9.5K", 720_000 → "720K",
 * 1_200_000 → "1.2M". Used in the Composer status bar where space is
 * tight but the order-of-magnitude matters (200K vs 700K is the
 * difference between "fast TTFT" and "expect a multi-second wait").
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
