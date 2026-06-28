/**
 * The currency-dollar escape that keeps remark-math from turning literal dollar
 * amounts ("$5 ... $10") into math, while leaving real LaTeX ($x$, $$...$$)
 * untouched.
 */
import { describe, expect, it } from 'vitest';
import { escapeCurrencyDollars } from '../src/lib/mathText';

describe('escapeCurrencyDollars', () => {
  it('escapes a $ directly followed by a digit (currency)', () => {
    expect(escapeCurrencyDollars('costs $5')).toBe('costs \\$5');
    expect(escapeCurrencyDollars('$1,200 total')).toBe('\\$1,200 total');
  });

  it('escapes BOTH currency amounts on a line (the false-positive case)', () => {
    // Without escaping, remark-math would treat "5 per hour and $10" as math.
    expect(escapeCurrencyDollars('costs $5 per hour and $10 total')).toBe(
      'costs \\$5 per hour and \\$10 total'
    );
  });

  it('leaves real inline math untouched ($ not followed by a digit)', () => {
    expect(escapeCurrencyDollars('$\\Omega(n)$ and $x = 5$')).toBe('$\\Omega(n)$ and $x = 5$');
    expect(escapeCurrencyDollars('$$\\limsup_{k} \\frac{a}{b}$$')).toBe('$$\\limsup_{k} \\frac{a}{b}$$');
  });

  it('does not double-escape an already-escaped dollar', () => {
    expect(escapeCurrencyDollars('\\$5')).toBe('\\$5');
  });

  it('handles a mix of currency and math', () => {
    expect(escapeCurrencyDollars('It costs $20 but $\\pi$ is math')).toBe(
      'It costs \\$20 but $\\pi$ is math'
    );
  });
});
