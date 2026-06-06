/**
 * Inline-image rendering: the model shows a picture by emitting a markdown
 * image, and it must render as a real <img> with the right src (so the user
 * sees it inline + can click to copy/save). Guards the "Guy Code can't show
 * images" regression.
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
