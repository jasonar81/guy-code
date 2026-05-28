/**
 * Office Open XML (docx / xlsx / pptx) → plain-text extraction.
 *
 * Why hand-rolled on top of fflate instead of mammoth / xlsx / officeparser:
 *   - `officeparser` pulls in tesseract.js (OCR) + pdfjs-dist — tens of MB
 *     of runtime we'd ship in every installer for functionality we don't
 *     need (we want text, not OCR, and we handle PDF natively via the API).
 *   - `mammoth` is docx-only and brings jszip + a stack of transitive deps.
 *   - `xlsx` (SheetJS) covers spreadsheets but the open-source 0.18.x line
 *     on npm carries a security advisory.
 *   All three Office formats are just ZIP archives of XML. We already want
 *   a tiny unzipper; `fflate` is ~30 KB, zero-dep, no install scripts. So we
 *   unzip with fflate and pull text out of the known XML parts ourselves.
 *
 * Extraction is intentionally text-only (no styling, no exact layout). An
 * LLM answering questions about the document needs the words, the sheet
 * values, and the slide text — not the formatting.
 *
 * Format-specific part layout:
 *   docx:  word/document.xml — body text lives in <w:t> runs; <w:p> is a
 *          paragraph (newline), <w:tab/> a tab, <w:br/> a line break.
 *          Headers/footers live in word/header*.xml / footer*.xml.
 *   xlsx:  xl/sharedStrings.xml holds the string pool (<si><t>…); each
 *          xl/worksheets/sheet*.xml references strings by index in
 *          <c t="s"><v>IDX</v></c>, or carries inline numbers/strings.
 *          We emit one TSV-ish line per row, tab-separated by column.
 *   pptx:  ppt/slides/slide*.xml — text lives in <a:t> runs; <a:p> is a
 *          paragraph. We label each slide.
 *
 * All parsing is regex/string based over the decompressed XML. We do NOT
 * use a full XML DOM parser — the structures we read are simple and a DOM
 * parser would be another dependency. Tolerant of malformed input: returns
 * whatever it recovers and never throws on structure.
 */

import { unzipSync, strFromU8 } from 'fflate';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

/** Decode XML entities that appear in OOXML text runs. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    // Ampersand last so we don't double-decode the entities above.
    .replace(/&amp;/g, '&');
}

function safeCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** Strip all XML tags from a fragment, leaving decoded text. */
function stripTags(xml: string): string {
  return decodeXmlEntities(xml.replace(/<[^>]+>/g, ''));
}

/**
 * Determine the Office kind from a filename extension. Returns null for
 * anything that isn't one of the three supported OOXML formats.
 */
export function officeKindFromExt(ext: string): OfficeKind | null {
  const e = ext.toLowerCase();
  if (e === 'docx') return 'docx';
  if (e === 'xlsx') return 'xlsx';
  if (e === 'pptx') return 'pptx';
  return null;
}

/** Sort archive entry names like sheet1, sheet2, …, sheet10 numerically. */
function numericPartSort(a: string, b: string): number {
  const na = parseInt((a.match(/(\d+)\.xml$/) || [])[1] ?? '0', 10);
  const nb = parseInt((b.match(/(\d+)\.xml$/) || [])[1] ?? '0', 10);
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

/** docx: pull paragraph text from word/document.xml (+ headers/footers). */
function extractDocx(files: Record<string, Uint8Array>): string {
  const parts: string[] = [];
  // Main body first, then headers/footers in archive order.
  const names = Object.keys(files);
  const ordered = [
    'word/document.xml',
    ...names.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort(numericPartSort),
  ].filter((n) => files[n]);

  for (const name of ordered) {
    const xml = strFromU8(files[name]);
    // Normalize structural tags to text BEFORE stripping the rest:
    //   <w:tab/>  → tab
    //   <w:br/>   → newline
    //   </w:p>    → paragraph break (newline)
    // Then strip remaining tags (which leaves <w:t> content concatenated).
    const normalized = xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n');
    parts.push(stripTags(normalized));
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** xlsx: resolve shared strings, then emit each sheet as TSV-ish rows. */
function extractXlsx(files: Record<string, Uint8Array>): string {
  // 1. Shared-string pool. Each <si> may contain one <t> or several runs
  //    of <r><t>…</t></r>; we just strip tags within each <si>.
  const shared: string[] = [];
  const ssName = Object.keys(files).find((n) => n.toLowerCase() === 'xl/sharedstrings.xml');
  if (ssName) {
    const ssXml = strFromU8(files[ssName]);
    const siMatches = ssXml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) || [];
    for (const si of siMatches) shared.push(stripTags(si));
  }

  // 2. Each worksheet. Order by sheetN numeric suffix.
  const sheetNames = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/i.test(n))
    .sort(numericPartSort);

  const out: string[] = [];
  let sheetIdx = 0;
  for (const name of sheetNames) {
    sheetIdx++;
    const xml = strFromU8(files[name]);
    const rows: string[] = [];
    const rowMatches = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
    for (const row of rowMatches) {
      const cells: string[] = [];
      const cellMatches = row.match(/<c\b[^>]*>[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || [];
      for (const cell of cellMatches) {
        const typeMatch = cell.match(/\bt="([^"]+)"/);
        const type = typeMatch ? typeMatch[1] : '';
        if (type === 's') {
          // Shared string: <v>INDEX</v>
          const v = cell.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
          const idx = v ? parseInt(stripTags(v[1]), 10) : NaN;
          cells.push(!Number.isNaN(idx) && shared[idx] !== undefined ? shared[idx] : '');
        } else if (type === 'inlineStr') {
          // Inline string: <is><t>…</t></is>
          const is = cell.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
          cells.push(is ? stripTags(is[1]) : '');
        } else {
          // Number / boolean / formula result: <v>…</v>
          const v = cell.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
          cells.push(v ? stripTags(v[1]) : '');
        }
      }
      // Only keep rows that have at least one non-empty cell.
      if (cells.some((c) => c.trim() !== '')) {
        rows.push(cells.join('\t'));
      }
    }
    if (rows.length > 0) {
      const label = sheetNames.length > 1 ? `--- Sheet ${sheetIdx} ---\n` : '';
      out.push(label + rows.join('\n'));
    }
  }
  return out.join('\n\n').trim();
}

/** pptx: pull <a:t> text per slide, labeled by slide number. */
function extractPptx(files: Record<string, Uint8Array>): string {
  const slideNames = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d*\.xml$/i.test(n))
    .sort(numericPartSort);

  const out: string[] = [];
  let idx = 0;
  for (const name of slideNames) {
    idx++;
    const xml = strFromU8(files[name]);
    // <a:p> paragraph → newline; <a:br> → newline. Then strip; the <a:t>
    // run contents survive as concatenated text.
    const normalized = xml
      .replace(/<a:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/a:p>/g, '\n');
    const text = stripTags(normalized).replace(/\n{3,}/g, '\n\n').trim();
    if (text) out.push(`--- Slide ${idx} ---\n${text}`);
  }
  return out.join('\n\n').trim();
}

/**
 * Extract plain text from an Office Open XML document.
 *
 * @param bytes  Raw file bytes (the .docx/.xlsx/.pptx ZIP container).
 * @param kind   Which OOXML format to parse.
 * @returns      Extracted text. Throws only if the bytes are not a valid
 *               ZIP archive (i.e. not a real OOXML file) — callers should
 *               translate that into a user-facing "couldn't read this file"
 *               message.
 */
export function extractOfficeText(bytes: Uint8Array, kind: OfficeKind): string {
  let files: Record<string, Uint8Array>;
  try {
    // We only need a subset of entries; decompress all (these archives are
    // small) and index by name. fflate's unzipSync is synchronous + fast.
    files = unzipSync(bytes);
  } catch (e) {
    throw new Error(
      `Not a valid ${kind} file (failed to open as a ZIP archive): ${(e as Error).message}`
    );
  }

  switch (kind) {
    case 'docx':
      return extractDocx(files);
    case 'xlsx':
      return extractXlsx(files);
    case 'pptx':
      return extractPptx(files);
  }
}
