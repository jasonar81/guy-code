/**
 * Escape a `$` that is clearly a literal dollar AMOUNT (a `$` immediately
 * followed by a digit, e.g. "$5", "$1,200") so remark-math doesn't mistake a
 * pair of currency figures on one line ("costs $5 and $10") for inline math.
 *
 * Genuine inline math almost never starts with a bare digit right after the
 * opening `$` (you write `$x=5$`, not `$5$`), so real math like `$\Omega(n)$`
 * and `$$...$$` is preserved. An already-escaped `\$` is left alone.
 */
export function escapeCurrencyDollars(s: string): string {
  return s.replace(/(^|[^\\])\$(?=\d)/g, '$1\\$');
}
