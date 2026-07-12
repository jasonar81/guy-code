/**
 * The send-path defense that drops images exceeding the API's 2000px
 * per-dimension cap (which otherwise wedges a session, since the bad image
 * rides along on every subsequent turn).
 */
import { describe, expect, it } from 'vitest';
import { sanitizeMessages } from '../electron/sessionRuntime';

// Build a minimal valid PNG (8-byte signature + IHDR with the given size).
// The dimension check only reads the IHDR header, so the pixel data can be
// empty.
function pngBase64(width: number, height: number): string {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // length
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  // bit depth / color type / etc + crc left zero - irrelevant to the check.
  return Buffer.concat([sig, ihdr]).toString('base64');
}

function imageMsg(width: number, height: number) {
  return {
    role: 'user' as const,
    content: [
      { type: 'text' as const, text: 'look at this' },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: pngBase64(width, height) },
      },
    ],
  };
}

describe('sanitizeMessages: oversized image defense', () => {
  it('drops an image wider than 2000px and leaves a marker', () => {
    const out = sanitizeMessages([imageMsg(2280, 1466)]);
    const blocks = out[0].content as any[];
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && /image removed/i.test(b.text))).toBe(true);
    // the original text block is preserved
    expect(blocks.some((b) => b.type === 'text' && b.text === 'look at this')).toBe(true);
  });

  it('drops an image taller than 2000px', () => {
    const out = sanitizeMessages([imageMsg(800, 2400)]);
    const blocks = out[0].content as any[];
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
  });

  it('keeps an image within 2000px in both dimensions', () => {
    const out = sanitizeMessages([imageMsg(1525, 614)]);
    const blocks = out[0].content as any[];
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });

  it('keeps an image exactly at 2000px', () => {
    const out = sanitizeMessages([imageMsg(2000, 2000)]);
    const blocks = out[0].content as any[];
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });
});

// A PDF's magic bytes, base64-encoded, mislabeled as image/png (the exact bug:
// ShowImage read a .pdf and stuffed it in an image block).
function pdfAsImageBase64(): string {
  return Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj', 'latin1').toString('base64');
}

describe('sanitizeMessages: mislabeled (non-image) data defense', () => {
  it('drops a PDF mislabeled as an image and leaves a marker', () => {
    const msg = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'here' },
        {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: 'image/png' as const, data: pdfAsImageBase64() },
        },
      ],
    };
    const out = sanitizeMessages([msg]);
    const blocks = out[0].content as any[];
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && /not a displayable image/i.test(b.text))).toBe(true);
    expect(blocks.some((b) => b.type === 'text' && b.text === 'here')).toBe(true);
  });

  it('drops a mislabeled image nested inside a tool_result (the ShowImage case)', () => {
    // A realistic pair: assistant tool_use (ShowImage) then the user tool_result
    // carrying the mislabeled image (so no unpaired-tool_result pass drops it).
    const assistant = {
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, id: 'toolu_x', name: 'ShowImage', input: {} }],
    };
    const user = {
      role: 'user' as const,
      content: [
        {
          type: 'tool_result' as const,
          tool_use_id: 'toolu_x',
          content: [
            { type: 'text' as const, text: 'Image: my note' },
            {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: 'image/png' as const, data: pdfAsImageBase64() },
            },
          ],
        },
      ],
    };
    const out = sanitizeMessages([assistant, user]);
    const userOut = out.find((m) => m.role === 'user')!;
    const tr = (userOut.content as any[])[0];
    expect(tr.type).toBe('tool_result');
    expect(tr.content.some((b: any) => b.type === 'image')).toBe(false);
    // the text part is preserved
    expect(tr.content.some((b: any) => b.type === 'text' && b.text === 'Image: my note')).toBe(true);
  });

  it('keeps a real PNG image untouched', () => {
    const out = sanitizeMessages([imageMsg(100, 100)]);
    const blocks = out[0].content as any[];
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });
});
