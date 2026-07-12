/**
 * detectImageType backs ShowImage's refusal to display non-images (a PDF passed
 * to ShowImage was labeled image/png and wedged a session on every turn).
 */
import { describe, expect, it } from 'vitest';
import { detectImageType } from '../electron/tools';

describe('detectImageType', () => {
  it('detects PNG', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8),
    ]);
    expect(detectImageType(png)).toBe('image/png');
  });

  it('detects JPEG', () => {
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(8)]);
    expect(detectImageType(jpg)).toBe('image/jpeg');
  });

  it('detects GIF', () => {
    expect(detectImageType(Buffer.from('GIF89a' + '\0'.repeat(8), 'latin1'))).toBe('image/gif');
  });

  it('detects WEBP', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'latin1'),
    ]);
    expect(detectImageType(webp)).toBe('image/webp');
  });

  it('returns null for a PDF (the bug)', () => {
    expect(detectImageType(Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1'))).toBeNull();
  });

  it('returns null for arbitrary text', () => {
    expect(detectImageType(Buffer.from('this is not an image at all', 'latin1'))).toBeNull();
  });

  it('returns null for too-short input', () => {
    expect(detectImageType(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});
