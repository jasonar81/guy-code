/**
 * Inline-image rendering: the model shows a picture by emitting a markdown
 * image, and it must render as a real <img> with the right src (so the user
 * sees it inline + can click to copy/save). Guards the "Guy Code can't show
 * images" regression.
 *
 * @vitest-environment jsdom
 *
 * (jsdom rather than the default happy-dom: RichText now pulls in rehype-katex,
 * which bails in happy-dom's quirks-mode document and blanks the render. jsdom
 * uses standards mode so KaTeX is happy.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { RichText } from '../src/components/RichText';
import { InlineImage } from '../src/components/InlineImage';

beforeEach(() => {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.api = {
    ...((globalThis as any).window.api ?? {}),
    image: { copy: vi.fn().mockResolvedValue({ ok: true }), save: vi.fn() },
  };
});

describe('RichText inline images', () => {
  it('renders a markdown http image as a clickable <img> with the url src', () => {
    const { container } = render(<RichText text="![a cat](https://example.com/cat.jpg)" />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('https://example.com/cat.jpg');
    expect(img!.getAttribute('alt')).toBe('a cat');
    expect(img!.className).toMatch(/cursor-zoom-in/);
  });

  it('renders a data: URL image inline', () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { container } = render(<RichText text={`![dot](${dataUrl})`} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe(dataUrl);
  });

  it('still renders ordinary text/links without images', () => {
    const { container } = render(<RichText text="hello [link](https://x.com) world" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://x.com');
  });
});

describe('InlineImage copy/save wiring', () => {
  it('copy button calls window.api.image.copy with the src', async () => {
    const copy = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as any).window.api.image.copy = copy;
    const { container } = render(<InlineImage src="https://example.com/c.png" alt="c" />);
    fireEvent.click(container.querySelector('img')!); // open lightbox
    fireEvent.click(await screen.findByText('Copy image'));
    expect(copy).toHaveBeenCalledWith('https://example.com/c.png');
  });

  it('save button calls window.api.image.save with the src', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true, path: '/tmp/x.png' });
    (globalThis as any).window.api.image.save = save;
    const { container } = render(<InlineImage src="https://example.com/c.png" />);
    fireEvent.click(container.querySelector('img')!);
    fireEvent.click(await screen.findByText('Save as…'));
    expect(save).toHaveBeenCalledWith('https://example.com/c.png');
  });
});

describe('ShowImage tool', () => {
  it('reads a local file and returns an inline image block (no base64 from the model)', async () => {
    const { TOOLS } = await import('../electron/tools');
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    // a 1x1 png
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const dir = mkdtempSync(join(tmpdir(), 'showimg-'));
    const p = join(dir, 'pic.png');
    writeFileSync(p, png);
    const out: any = await TOOLS['ShowImage'].execute({ path: p, alt: 'a dot' }, { sessionId: 's', cwd: '' } as any);
    expect(out.modelContent).toBeTruthy();
    const imgBlock = out.modelContent.find((b: any) => b.type === 'image');
    expect(imgBlock).toBeTruthy();
    expect(imgBlock.source.media_type).toBe('image/png');
    expect(imgBlock.source.data).toBe(png.toString('base64'));
  });

  it('errors cleanly with no source', async () => {
    const { TOOLS } = await import('../electron/tools');
    const out: any = await TOOLS['ShowImage'].execute({}, { sessionId: 's', cwd: '' } as any);
    const txt = out.modelContent.map((b: any) => b.text || '').join(' ');
    expect(txt).toMatch(/needs a path or url/i);
  });

  it('errors cleanly on a missing file', async () => {
    const { TOOLS } = await import('../electron/tools');
    const out: any = await TOOLS['ShowImage'].execute({ path: '/no/such/file.png' }, { sessionId: 's', cwd: '' } as any);
    const txt = out.modelContent.map((b: any) => b.text || '').join(' ');
    expect(txt).toMatch(/could not load image/i);
  });
});

describe('tool-result images render for the user (ShowImage/AppScreenshot)', () => {
  it('ToolResultBody renders image blocks from an array content (post-reload path)', async () => {
    const { ToolResultBody } = await import('../src/components/ToolResultBody');
    const toolUse: any = { type: 'tool_use', id: 't1', name: 'ShowImage', input: { path: '/x.png' } };
    const result: any = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [
        { type: 'text', text: 'Image shown inline.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    };
    const { container } = render(<ToolResultBody toolUse={toolUse} result={result} />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('ToolCallCard renders result.images inline (live path) without expanding', async () => {
    const { ToolCallCard } = await import('../src/components/ToolCallCard');
    const toolUse: any = { type: 'tool_use', id: 't2', name: 'ShowImage', input: {} };
    const result: any = {
      type: 'tool_result',
      tool_use_id: 't2',
      content: 'Image shown inline.',
      images: [{ media_type: 'image/png', data: 'BBBB' }],
    };
    const { container } = render(<ToolCallCard toolUse={toolUse} result={result} />);
    // The image renders WITHOUT clicking to expand the card.
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,BBBB');
  });
});
