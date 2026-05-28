/**
 * Tests for `electron/rtf.ts` — the self-contained RTF → plain-text
 * extractor. Pure function, no mocking.
 *
 * Focus areas:
 *   • Basic text recovery from a well-formed RTF document.
 *   • Control-word stripping (formatting toggles produce no output).
 *   • Paragraph / line / tab breaks map to whitespace.
 *   • Destination groups (fonttbl, colortbl, stylesheet, info) are
 *     skipped — their contents must NOT leak into the text.
 *   • Ignorable destinations (\*\...) are skipped.
 *   • Hex escapes (\'xx) and Unicode escapes (\uN) decode correctly,
 *     including the \uc fallback-skip behavior.
 *   • Escaped literals (\\, \{, \}) survive.
 *   • Malformed / non-RTF input doesn't throw.
 */
import { describe, expect, it } from 'vitest';
import { rtfToText } from '../electron/rtf';

describe('rtfToText', () => {
  it('extracts plain text from a simple document', () => {
    const rtf = `{\\rtf1\\ansi\\deff0 Hello, world!}`;
    expect(rtfToText(rtf)).toBe('Hello, world!');
  });

  it('drops formatting control words but keeps their text', () => {
    // Realistic RTF: the inter-word spaces are LITERAL text (before the
    // toggle control word), which is how Word emits it. The control words
    // \b \b0 \i \i0 produce no output.
    const rtf = `{\\rtf1 \\b bold\\b0  and \\i italic\\i0  done}`;
    expect(rtfToText(rtf)).toBe('bold and italic done');
  });

  it('treats the single space after a control word as a delimiter (consumed)', () => {
    // Documents the RTF spec rule: exactly one space following a control
    // word is the delimiter and is NOT output. So "\\b0 and" loses that
    // space. Authors keep words separated by putting the space as literal
    // text. This test pins the behavior so we notice if it changes.
    const rtf = `{\\rtf1 a\\b0 b}`;
    expect(rtfToText(rtf)).toBe('ab');
  });

  it('maps \\par to newlines', () => {
    const rtf = `{\\rtf1 line one\\par line two\\par line three}`;
    expect(rtfToText(rtf)).toBe('line one\nline two\nline three');
  });

  it('maps \\tab to a tab and \\line to a newline', () => {
    const rtf = `{\\rtf1 a\\tab b\\line c}`;
    expect(rtfToText(rtf)).toBe('a\tb\nc');
  });

  it('skips the font table destination', () => {
    const rtf = `{\\rtf1{\\fonttbl{\\f0 Times New Roman;}{\\f1 Arial;}}Body text here}`;
    expect(rtfToText(rtf)).toBe('Body text here');
  });

  it('skips color table + stylesheet + info destinations', () => {
    const rtf =
      `{\\rtf1` +
      `{\\colortbl;\\red0\\green0\\blue0;\\red255\\green0\\blue0;}` +
      `{\\stylesheet{\\s0 Normal;}}` +
      `{\\info{\\author Jane Doe}{\\title Secret Title}}` +
      `Visible body}`;
    const out = rtfToText(rtf);
    expect(out).toBe('Visible body');
    expect(out).not.toContain('Jane Doe');
    expect(out).not.toContain('Secret Title');
    expect(out).not.toContain('Normal');
  });

  it('skips ignorable destinations marked with \\*', () => {
    const rtf = `{\\rtf1 keep this {\\*\\generator Some Tool 1.0;}and this}`;
    expect(rtfToText(rtf)).toBe('keep this and this');
  });

  it('decodes hex escapes (\\\'xx) as Latin-1 bytes', () => {
    // \'e9 = é in Latin-1 (0xE9 → U+00E9)
    const rtf = `{\\rtf1 caf\\'e9}`;
    expect(rtfToText(rtf)).toBe('café');
  });

  it('decodes Unicode escapes (\\uN) and skips the fallback char', () => {
    // \u8364 = € ; the '?' is the \uc1 best-fit fallback that must be skipped
    const rtf = `{\\rtf1 price: \\u8364?100}`;
    expect(rtfToText(rtf)).toBe('price: €100');
  });

  it('honors \\ucN for multi-char fallback skipping', () => {
    // \uc2 means 2 fallback bytes follow each \u; "XY" is the fallback
    const rtf = `{\\rtf1 \\uc2\\u8364 XYdone}`;
    // € then skip 2 chars (the space and X? actually space is consumed as
    // delimiter after \u8364... ) — assert the euro survives and fallback
    // bytes are gone, leaving "done".
    const out = rtfToText(rtf);
    expect(out.startsWith('€')).toBe(true);
    expect(out).toContain('done');
    expect(out).not.toContain('XY');
  });

  it('preserves escaped braces and backslashes', () => {
    const rtf = `{\\rtf1 a \\{ b \\} c \\\\ d}`;
    expect(rtfToText(rtf)).toBe('a { b } c \\ d');
  });

  it('treats \\~ as a (non-breaking) space', () => {
    const rtf = `{\\rtf1 a\\~b}`;
    expect(rtfToText(rtf)).toBe('a\u00A0b');
  });

  it('collapses 3+ blank lines to a paragraph gap', () => {
    const rtf = `{\\rtf1 a\\par\\par\\par\\par b}`;
    expect(rtfToText(rtf)).toBe('a\n\nb');
  });

  it('does not throw on empty / non-RTF input', () => {
    expect(() => rtfToText('')).not.toThrow();
    expect(() => rtfToText('not rtf at all')).not.toThrow();
    expect(() => rtfToText('{\\rtf1 unterminated')).not.toThrow();
  });

  it('recovers text from input missing the version token', () => {
    const rtf = `{\\rtf hello there}`;
    expect(rtfToText(rtf)).toContain('hello there');
  });

  it('skips raw CR/LF in the source (real breaks come from \\par)', () => {
    const rtf = `{\\rtf1 line one\nstill line one\\par line two}`;
    expect(rtfToText(rtf)).toBe('line onestill line one\nline two');
  });
});
