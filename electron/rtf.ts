/**
 * Minimal, self-contained RTF → plain-text extractor.
 *
 * Why hand-rolled instead of a dependency:
 *   The npm RTF parsers are either unmaintained, pull in heavy deps, or
 *   target *generation* rather than text extraction. All we need is the
 *   visible text out of an RTF document so the model can read it — not a
 *   faithful style-preserving conversion. RTF's grammar for that subset
 *   is small enough to handle directly, and a self-contained function
 *   has zero supply-chain surface.
 *
 * What RTF looks like (the parts that matter here):
 *   - The whole document is wrapped in a group: `{\rtf1 ... }`.
 *   - Groups nest with `{` / `}`.
 *   - Control WORDS: a backslash, ASCII letters, an optional signed
 *     integer parameter, and an optional single trailing space that is
 *     part of the control word (NOT output): e.g. `\par`, `\b0`, `\fs24`,
 *     `\u8364?` (Unicode), `\'e9` (hex byte).
 *   - Control SYMBOLS: a backslash followed by a single non-letter:
 *     `\\`, `\{`, `\}`, `\~` (nbsp), `\-` (optional hyphen), `\_`
 *     (non-breaking hyphen), `\*` (ignorable-destination marker).
 *   - Everything else is literal text.
 *
 * Extraction rules we implement:
 *   1. Track group depth. Certain "destination" control words introduce
 *      metadata groups whose TEXT must be skipped entirely (font tables,
 *      color tables, stylesheets, info, embedded pictures, etc.). When we
 *      see one of those as the FIRST token in a group, we skip to the
 *      matching close brace.
 *   2. `\*\foo` marks an ignorable destination — skip the whole group.
 *      We also skip the group for any unknown destination introduced via
 *      `\*` so we never dump binary/markup garbage into the text.
 *   3. Paragraph / line breaks (`\par`, `\line`, `\sect`, `\page`) emit a
 *      newline. Tabs (`\tab`) emit a tab. Non-breaking space (`\~`) emits
 *      a space. Cell / row breaks emit a tab / newline so tables stay
 *      vaguely readable.
 *   4. `\'hh` emits the byte 0xHH decoded as Latin-1 (the common default;
 *      full codepage handling is out of scope — RTF rarely uses anything
 *      exotic for the Latin text people attach, and getting the ASCII
 *      range right covers the vast majority).
 *   5. `\uN` emits the Unicode code point N (handling RTF's signed-16-bit
 *      quirk where negative values represent code points > 32767), then
 *      skips the following `\ucN` "best-fit" fallback characters (default
 *      1).
 *   6. Unknown control words are dropped (no output) but do NOT skip the
 *      group — they're usually formatting toggles (`\b`, `\i`, `\fs24`).
 *
 * This is deliberately lossy on layout but faithful on textual content,
 * which is exactly what an LLM needs to answer questions about the file.
 */

// Control words that introduce a destination group whose textual content
// is metadata, not document body. When one of these is the first control
// word inside a group, we skip the entire group.
const SKIP_DESTINATIONS = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'objdata',
  'themedata',
  'colorschememapping',
  'latentstyles',
  'datastore',
  'generator',
  'filetbl',
  'listtable',
  'listoverridetable',
  'revtbl',
  'rsidtbl',
  'mmathPr',
  'fldinst', // field instruction (e.g. HYPERLINK codes) — skip the code, keep result
  'xmlnstbl',
  'wgrffmtfilter',
]);

// Control words that emit whitespace / breaks.
const BREAK_WORDS: Record<string, string> = {
  par: '\n',
  line: '\n',
  sect: '\n',
  page: '\n',
  tab: '\t',
  cell: '\t',
  nestcell: '\t',
  row: '\n',
  nestrow: '\n',
  lbr: '\n',
};

/**
 * Extract plain text from an RTF document supplied as a string.
 * Tolerant of malformed input — never throws on structure; worst case it
 * returns whatever text it managed to recover.
 */
export function rtfToText(rtf: string): string {
  // Fast bail for obviously-not-RTF input. We still attempt extraction if
  // the signature is missing but there are backslash control words,
  // because some tools omit the version token.
  const out: string[] = [];

  // Group stack. Each frame tracks whether we're inside a destination we
  // should skip the text of, and how many Unicode fallback chars to skip.
  interface Frame {
    skip: boolean; // suppress text output within this group
    uc: number; // \ucN — number of bytes to skip after a \uN
    sawFirstToken: boolean; // whether the leading token of the group is seen
  }
  const stack: Frame[] = [{ skip: false, uc: 1, sawFirstToken: true }];
  const top = () => stack[stack.length - 1];

  let i = 0;
  const n = rtf.length;
  // Track a pending "this group is an ignorable destination" flag set by
  // a `\*` symbol; the NEXT control word's group becomes skippable.
  let pendingIgnorable = false;

  while (i < n) {
    const ch = rtf[i];

    if (ch === '{') {
      // Open a new group inheriting skip + uc from the parent.
      const parent = top();
      stack.push({ skip: parent.skip, uc: parent.uc, sawFirstToken: false });
      i++;
      continue;
    }

    if (ch === '}') {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }

    if (ch === '\\') {
      // Control word or control symbol.
      const next = rtf[i + 1];
      if (next === undefined) {
        i++;
        continue;
      }

      // Control symbol: backslash + single non-letter.
      if (!/[a-zA-Z]/.test(next)) {
        i += 2;
        if (next === '\\' || next === '{' || next === '}') {
          if (!top().skip) out.push(next);
        } else if (next === '~') {
          if (!top().skip) out.push('\u00A0'); // non-breaking space
        } else if (next === '*') {
          // Ignorable-destination marker. The control word that follows
          // belongs to a destination whose contents we skip.
          pendingIgnorable = true;
        } else if (next === '\n' || next === '\r') {
          // Escaped line break in source → paragraph break.
          if (!top().skip) out.push('\n');
        } else if (next === "'") {
          // This shouldn't happen (handled below as letter? no — ' is
          // non-letter). Handle \'hh here.
          // Back up: we already consumed the quote; read two hex digits.
          const hex = rtf.slice(i, i + 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            i += 2;
            if (!top().skip) out.push(String.fromCharCode(parseInt(hex, 16)));
          }
        }
        // Other control symbols (\-, \_, etc.) produce no visible text.
        // Mark first-token-seen so a following destination check is correct.
        top().sawFirstToken = true;
        continue;
      }

      // Control word: \ + letters + optional signed number + optional space.
      let j = i + 1;
      while (j < n && /[a-zA-Z]/.test(rtf[j])) j++;
      const word = rtf.slice(i + 1, j);
      // Optional numeric parameter (may be negative).
      let numStr = '';
      if (rtf[j] === '-') {
        numStr = '-';
        j++;
      }
      while (j < n && /[0-9]/.test(rtf[j])) {
        numStr += rtf[j];
        j++;
      }
      // A single trailing space is consumed as a delimiter (not output).
      if (rtf[j] === ' ') j++;
      const param = numStr === '' || numStr === '-' ? null : parseInt(numStr, 10);
      i = j;

      const frame = top();
      const isFirst = !frame.sawFirstToken;
      frame.sawFirstToken = true;

      // Handle the special hex escape that arrives as a "word" in some
      // tokenizers is already handled above. Here process real words.

      if (word === 'u') {
        // Unicode code point. param may be negative (signed 16-bit).
        if (param !== null) {
          let cp = param;
          if (cp < 0) cp += 65536;
          if (!frame.skip) {
            try {
              out.push(String.fromCodePoint(cp));
            } catch {
              /* invalid code point — drop */
            }
          }
          // Skip the next `uc` fallback characters/tokens.
          let toSkip = frame.uc;
          while (toSkip > 0 && i < n) {
            if (rtf[i] === '\\' && rtf[i + 1] === "'") {
              i += 4; // \'hh
            } else if (rtf[i] === '{' || rtf[i] === '}') {
              break; // don't cross group boundaries
            } else {
              i++;
            }
            toSkip--;
          }
        }
        continue;
      }

      if (word === 'uc') {
        if (param !== null) frame.uc = param;
        continue;
      }

      // Destination skipping. If this is the first token in the group and
      // it names a skip-destination (or we're in a pending-ignorable
      // group), suppress text for the whole group.
      if (pendingIgnorable) {
        pendingIgnorable = false;
        // Any \* destination: if it's not one we explicitly want to keep,
        // skip it. We currently keep none, so skip all ignorable dests.
        frame.skip = true;
        continue;
      }
      if (isFirst && SKIP_DESTINATIONS.has(word)) {
        frame.skip = true;
        continue;
      }

      // Break / whitespace words.
      const brk = BREAK_WORDS[word];
      if (brk !== undefined) {
        if (!frame.skip) out.push(brk);
        continue;
      }

      // Everything else (formatting toggles, font sizes, etc.) → no output.
      continue;
    }

    // Literal text. Skip raw CR/LF in the RTF source (they're not content;
    // real breaks come from \par). Output everything else unless skipping.
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (!top().skip) out.push(ch);
    top().sawFirstToken = true;
    i++;
  }

  // Normalize: collapse 3+ newlines to 2, trim trailing spaces per line,
  // and trim the whole thing.
  let text = out.join('');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}
