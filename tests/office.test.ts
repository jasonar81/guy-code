/**
 * Tests for `electron/office.ts` — Office Open XML (docx/xlsx/pptx) text
 * extraction. We build *real* OOXML ZIP archives in-memory with fflate's
 * `zipSync` and the minimal XML parts each extractor reads, then assert
 * the recovered text. No mocking — exercises the real unzip + parse path.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extractOfficeText, officeKindFromExt } from '../electron/office';

/** Build a Uint8Array OOXML archive from a map of part-name → xml string. */
function buildZip(parts: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, xml] of Object.entries(parts)) {
    entries[name] = strToU8(xml);
  }
  return zipSync(entries);
}

describe('officeKindFromExt', () => {
  it('maps the three OOXML extensions', () => {
    expect(officeKindFromExt('docx')).toBe('docx');
    expect(officeKindFromExt('xlsx')).toBe('xlsx');
    expect(officeKindFromExt('pptx')).toBe('pptx');
    expect(officeKindFromExt('DOCX')).toBe('docx');
  });
  it('returns null for non-OOXML extensions', () => {
    expect(officeKindFromExt('doc')).toBeNull();
    expect(officeKindFromExt('pdf')).toBeNull();
    expect(officeKindFromExt('txt')).toBeNull();
  });
});

describe('extractOfficeText — docx', () => {
  it('extracts paragraph text from word/document.xml', () => {
    const docx = buildZip({
      '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
      'word/document.xml':
        `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
        `<w:p><w:r><w:t>First paragraph.</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Second </w:t></w:r><w:r><w:t>paragraph.</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    });
    const text = extractOfficeText(docx, 'docx');
    expect(text).toContain('First paragraph.');
    expect(text).toContain('Second paragraph.');
    // Paragraph boundary becomes a newline.
    expect(text).toBe('First paragraph.\nSecond paragraph.');
  });

  it('maps <w:tab/> and <w:br/> to tab and newline', () => {
    const docx = buildZip({
      'word/document.xml':
        `<w:document><w:body><w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p></w:body></w:document>`,
    });
    expect(extractOfficeText(docx, 'docx')).toBe('a\tb\nc');
  });

  it('decodes XML entities in run text', () => {
    const docx = buildZip({
      'word/document.xml':
        `<w:document><w:body><w:p><w:r><w:t>A &amp; B &lt; C &gt; D</w:t></w:r></w:p></w:body></w:document>`,
    });
    expect(extractOfficeText(docx, 'docx')).toBe('A & B < C > D');
  });

  it('includes header/footer text', () => {
    const docx = buildZip({
      'word/document.xml':
        `<w:document><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`,
      'word/header1.xml':
        `<w:hdr><w:p><w:r><w:t>Page header</w:t></w:r></w:p></w:hdr>`,
    });
    const text = extractOfficeText(docx, 'docx');
    expect(text).toContain('Body');
    expect(text).toContain('Page header');
  });
});

describe('extractOfficeText — xlsx', () => {
  it('resolves shared strings and emits TSV rows', () => {
    const xlsx = buildZip({
      'xl/sharedStrings.xml':
        `<sst><si><t>Name</t></si><si><t>Age</t></si><si><t>Alice</t></si></sst>`,
      'xl/worksheets/sheet1.xml':
        `<worksheet><sheetData>` +
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
        `<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c></row>` +
        `</sheetData></worksheet>`,
    });
    const text = extractOfficeText(xlsx, 'xlsx');
    // Header row + data row, tab-separated.
    expect(text).toBe('Name\tAge\nAlice\t30');
  });

  it('handles inline strings and numeric cells', () => {
    const xlsx = buildZip({
      'xl/worksheets/sheet1.xml':
        `<worksheet><sheetData>` +
        `<row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c><c r="B1"><v>42</v></c></row>` +
        `</sheetData></worksheet>`,
    });
    expect(extractOfficeText(xlsx, 'xlsx')).toBe('Inline\t42');
  });

  it('labels multiple sheets', () => {
    const xlsx = buildZip({
      'xl/sharedStrings.xml': `<sst><si><t>X</t></si></sst>`,
      'xl/worksheets/sheet1.xml':
        `<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c></row></sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml':
        `<worksheet><sheetData><row r="1"><c><v>99</v></c></row></sheetData></worksheet>`,
    });
    const text = extractOfficeText(xlsx, 'xlsx');
    expect(text).toContain('--- Sheet 1 ---');
    expect(text).toContain('--- Sheet 2 ---');
    expect(text).toContain('X');
    expect(text).toContain('99');
  });

  it('skips empty rows', () => {
    const xlsx = buildZip({
      'xl/worksheets/sheet1.xml':
        `<worksheet><sheetData>` +
        `<row r="1"><c><v>1</v></c></row>` +
        `<row r="2"><c></c></row>` +
        `<row r="3"><c><v>3</v></c></row>` +
        `</sheetData></worksheet>`,
    });
    expect(extractOfficeText(xlsx, 'xlsx')).toBe('1\n3');
  });
});

describe('extractOfficeText — pptx', () => {
  it('extracts slide text labeled by slide number', () => {
    const pptx = buildZip({
      'ppt/slides/slide1.xml':
        `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>` +
        `<a:p><a:r><a:t>Title slide</a:t></a:r></a:p>` +
        `<a:p><a:r><a:t>Subtitle</a:t></a:r></a:p>` +
        `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      'ppt/slides/slide2.xml':
        `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>` +
        `<a:p><a:r><a:t>Second slide bullet</a:t></a:r></a:p>` +
        `</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    });
    const text = extractOfficeText(pptx, 'pptx');
    expect(text).toContain('--- Slide 1 ---');
    expect(text).toContain('Title slide');
    expect(text).toContain('Subtitle');
    expect(text).toContain('--- Slide 2 ---');
    expect(text).toContain('Second slide bullet');
  });

  it('orders slides numerically (slide2 before slide10)', () => {
    const parts: Record<string, string> = {};
    for (const n of [1, 2, 10]) {
      parts[`ppt/slides/slide${n}.xml`] =
        `<p:sld><a:p><a:r><a:t>slide-${n}-text</a:t></a:r></a:p></p:sld>`;
    }
    const text = extractOfficeText(buildZip(parts), 'pptx');
    const i1 = text.indexOf('slide-1-text');
    const i2 = text.indexOf('slide-2-text');
    const i10 = text.indexOf('slide-10-text');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i10);
  });
});

describe('extractOfficeText — error handling', () => {
  it('throws on bytes that are not a valid ZIP archive', () => {
    const notZip = strToU8('this is plainly not a zip file at all');
    expect(() => extractOfficeText(notZip, 'docx')).toThrow(/not a valid docx/i);
  });

  it('returns empty string for an archive with no recognized parts', () => {
    const empty = buildZip({ 'random.xml': '<foo/>' });
    expect(extractOfficeText(empty, 'docx')).toBe('');
  });
});
