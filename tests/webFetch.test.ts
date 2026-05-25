/**
 * Tests for `electron/webFetch.ts`.
 *
 * The tool sits between the model and the open internet — bugs here
 * either let bad URLs hang the whole turn or quietly truncate
 * readable content. We pin down:
 *   • Input validation: empty / non-http URLs reject without touching
 *     the network.
 *   • HTTP error codes turn into `error: HTTP nnn` strings, not
 *     thrown exceptions.
 *   • HTML payloads run through Readability and emit the canonical
 *     `Title: ...\nURL: ...\n\n<body>` shape (downstream summarizer
 *     depends on those header lines).
 *   • Plain-text payloads pass through verbatim with a metadata
 *     header.
 *   • Body cap is enforced via the streaming reader BEFORE the
 *     full payload allocates.
 *   • Timeouts surface as a clear error with the URL named.
 *
 * Mocks: `vi.stubGlobal('fetch', ...)` swaps the real fetch with a
 * test fake. Each test wires up its own response shape — Response
 * with text body, Response with chunked stream, AbortError, etc.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webFetch } from '../electron/webFetch';

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Helpers -----------------------------------------------------------

/**
 * Build a fake Response object that webFetch's body-streaming path
 * understands. We can't use the global Response constructor's
 * stream wiring directly under happy-dom in some envs, so we mock
 * just the surface webFetch reads: ok, status, statusText, url,
 * headers, body.getReader().
 */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
  contentType?: string;
  body: string;
  /** If set, split body into chunks (for body-cap testing). */
  chunkSize?: number;
}): Response {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  const body = opts.body;
  const chunkSize = opts.chunkSize ?? body.length;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < body.length; i += chunkSize) {
    chunks.push(encoder.encode(body.slice(i, i + chunkSize)));
  }
  let pos = 0;
  const reader = {
    read: async () => {
      if (pos >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[pos++] };
    },
    cancel: async () => {
      pos = chunks.length;
    },
  };
  return {
    ok,
    status,
    statusText: opts.statusText ?? (ok ? 'OK' : 'Error'),
    url: opts.url ?? 'https://example.com/',
    headers: new Headers({
      'content-type': opts.contentType ?? 'text/html; charset=utf-8',
    }),
    body: { getReader: () => reader },
  } as unknown as Response;
}

// ---- Input validation --------------------------------------------------

describe('webFetch input validation', () => {
  it('rejects empty url without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await webFetch({ url: '' });
    expect(r).toMatch(/^error: url is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) urls', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const url of ['file:///etc/passwd', 'ftp://server/file', 'javascript:alert(1)']) {
      const r = await webFetch({ url });
      expect(r, `url=${url}`).toMatch(/^error: only http\(s\)/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---- HTTP errors -------------------------------------------------------

describe('webFetch HTTP errors', () => {
  it('returns "error: HTTP nnn" for non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          url: 'https://example.com/missing',
          body: '<html><body>404</body></html>',
        })
      )
    );
    const r = await webFetch({ url: 'https://example.com/missing' });
    expect(r).toMatch(/^error: HTTP 404 Not Found/);
    expect(r).toContain('https://example.com/missing');
  });

  it('handles fetch() throwing (network failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const r = await webFetch({ url: 'https://example.com/' });
    expect(r).toMatch(/^error: fetch failed/);
    expect(r).toContain('ECONNREFUSED');
  });

  it('classifies AbortError separately as a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      })
    );
    const r = await webFetch({ url: 'https://example.com/' });
    expect(r).toMatch(/^error: timed out after/);
  });
});

// ---- HTML extraction ---------------------------------------------------

describe('webFetch HTML extraction', () => {
  it('runs Readability and emits Title / URL header lines', async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Article Title</title></head>
        <body>
          <nav>nav garbage</nav>
          <article>
            <h1>Main Heading</h1>
            <p>This is the first paragraph of the article. It is long enough to be picked up by Readability and not dismissed as boilerplate. We add several more sentences to make sure the heuristic clears its threshold for substantive content.</p>
            <p>This is a second paragraph with more substantive content. Readability needs at least a couple of these to confidently identify the article body as the main content.</p>
          </article>
          <footer>footer junk</footer>
        </body>
      </html>
    `;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          url: 'https://example.com/article',
          contentType: 'text/html; charset=utf-8',
          body: html,
        })
      )
    );
    const r = await webFetch({ url: 'https://example.com/article' });
    expect(r).toMatch(/^Title: /);
    expect(r).toMatch(/URL: https:\/\/example\.com\/article/);
    expect(r).toContain('first paragraph of the article');
    // Boilerplate stripped
    expect(r).not.toContain('nav garbage');
    expect(r).not.toContain('footer junk');
  });

  it('falls back to body.textContent when Readability cannot identify an article', async () => {
    // Login-page-shaped HTML — no main article. Readability typically
    // bails on these. We expect SOMETHING readable, not an empty body.
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Login</title></head>
        <body>
          <form><input type="text"/><button>Sign in</button></form>
          <span>welcome to the login</span>
        </body>
      </html>
    `;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          url: 'https://example.com/login',
          contentType: 'text/html',
          body: html,
        })
      )
    );
    const r = await webFetch({ url: 'https://example.com/login' });
    expect(r).toMatch(/Title:/);
    expect(r).toMatch(/URL: https:\/\/example\.com\/login/);
    // Some recognizable body text from the page should be present
    // even if Readability gave up — the fallback gathers from body.
    expect(r).toMatch(/Sign in|welcome to the login/);
  });
});

// ---- Plain-text payloads -----------------------------------------------

describe('webFetch non-HTML payloads', () => {
  it('passes plain text through with a metadata header', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          url: 'https://example.com/raw.txt',
          contentType: 'text/plain; charset=utf-8',
          body: 'hello\nworld\n',
        })
      )
    );
    const r = await webFetch({ url: 'https://example.com/raw.txt' });
    expect(r).toMatch(/^URL: https:\/\/example\.com\/raw\.txt/);
    expect(r).toMatch(/Content-Type: text\/plain/);
    expect(r).toContain('hello\nworld');
  });

  it('passes JSON through verbatim', async () => {
    const body = JSON.stringify({ a: 1, b: [2, 3] });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({
          url: 'https://api.example.com/data',
          contentType: 'application/json',
          body,
        })
      )
    );
    const r = await webFetch({ url: 'https://api.example.com/data' });
    expect(r).toContain('Content-Type: application/json');
    expect(r).toContain(body);
  });
});

// ---- Body cap ----------------------------------------------------------

describe('webFetch body cap', () => {
  it('rejects responses exceeding the 5 MB body cap (streamed)', async () => {
    // Build a > 5 MB body in chunks. Each iteration of read() yields
    // a fresh 1 MB chunk, and webFetch should cancel partway through.
    const oneMb = 1024 * 1024;
    const totalChunks = 8;
    let yielded = 0;
    let cancelled = false;
    const reader = {
      read: async () => {
        if (yielded >= totalChunks) return { done: true, value: undefined };
        yielded++;
        return { done: false, value: new Uint8Array(oneMb) };
      },
      cancel: async () => {
        cancelled = true;
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          url: 'https://example.com/huge',
          headers: new Headers({ 'content-type': 'text/html' }),
          body: { getReader: () => reader },
        } as unknown as Response;
      })
    );
    const r = await webFetch({ url: 'https://example.com/huge' });
    expect(r).toMatch(/^error: response body exceeded/);
    // Reader should have been cancelled, AND fewer than total chunks
    // should have been read (we bail as soon as cumulative bytes
    // exceed the 5 MB cap, which is at chunk 6 of 8).
    expect(cancelled).toBe(true);
    expect(yielded).toBeLessThan(totalChunks);
  });
});
