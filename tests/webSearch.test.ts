/**
 * Tests for `electron/webSearch.ts`.
 *
 * The local DuckDuckGo-backed WebSearch tool replaces Anthropic's
 * server-side `web_search_20250305` (which is gated per organization).
 * Bugs here either:
 *   • Return zero results to the model (DDG layout shifted, parser drifted),
 *   • Hand the model DDG redirect URLs instead of real destinations
 *     (so WebFetch follows another hop and the URL surfaced to the user
 *     looks like tracking junk), or
 *   • Hang the whole turn when the network is slow.
 *
 * We pin down each of those:
 *   • Input validation — empty query rejects without a network call.
 *   • Parser extracts title, URL, snippet from realistic DDG HTML.
 *   • Redirect unwrap handles `/l/?uddg=...` (relative + absolute), strips
 *     ad markers, ignores DDG-internal links.
 *   • Format produces the canonical "Search results for: …" header.
 *   • HTTP error path surfaces `error: DuckDuckGo returned HTTP nnn`.
 *   • Network failure / timeout produces a clear error string (no throw).
 *   • End-to-end: a fake fetch returning DDG-style HTML produces the
 *     expected formatted text.
 *
 * Mocks: `vi.stubGlobal('fetch', ...)` swaps the real fetch for these
 * tests. Each test wires its own response shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  webSearch,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoRedirect,
  formatResults,
} from '../electron/webSearch';

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- Helpers -----------------------------------------------------------

function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
  body: string;
}): Response {
  const ok = opts.ok ?? true;
  const status = opts.status ?? 200;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode(opts.body)];
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
    url: opts.url ?? 'https://html.duckduckgo.com/html/',
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body: { getReader: () => reader },
  } as unknown as Response;
}

/**
 * Generate a realistic DuckDuckGo `/html/` results page. Mirrors the
 * structure as of 2026: each `.result` block holds `.result__a` (title
 * link with /l/?uddg= redirect href) and `.result__snippet`. We don't
 * try to match every DDG-specific class; the parser keys on the stable
 * `.result__a` / `.result__snippet` selectors.
 */
function makeDuckDuckGoHtml(
  results: Array<{ title: string; destUrl: string; snippet: string }>
): string {
  const blocks = results
    .map((r) => {
      const wrapped =
        '/l/?uddg=' + encodeURIComponent(r.destUrl) + '&rut=abc123';
      return `
        <div class="result">
          <h2 class="result__title">
            <a class="result__a" href="${wrapped}">${r.title}</a>
          </h2>
          <a class="result__snippet" href="${wrapped}">${r.snippet}</a>
        </div>
      `;
    })
    .join('\n');
  return `<!DOCTYPE html><html><body>
    <div class="results">${blocks}</div>
  </body></html>`;
}

// ---- unwrapDuckDuckGoRedirect ------------------------------------------

describe('unwrapDuckDuckGoRedirect', () => {
  it('returns empty string for falsy input', () => {
    expect(unwrapDuckDuckGoRedirect('')).toBe('');
  });

  it('extracts uddg from a relative redirector path', () => {
    const dest = 'https://docs.python.org/3/library/asyncio.html';
    const wrapped = '/l/?uddg=' + encodeURIComponent(dest) + '&rut=xyz';
    expect(unwrapDuckDuckGoRedirect(wrapped)).toBe(dest);
  });

  it('extracts uddg from an absolute DDG redirector URL', () => {
    const dest = 'https://example.com/article';
    const wrapped =
      'https://duckduckgo.com/l/?uddg=' +
      encodeURIComponent(dest) +
      '&rut=abc';
    expect(unwrapDuckDuckGoRedirect(wrapped)).toBe(dest);
  });

  it('passes through plain absolute URLs unchanged', () => {
    expect(unwrapDuckDuckGoRedirect('https://example.com/page')).toBe(
      'https://example.com/page'
    );
  });

  it('promotes protocol-relative URLs to https', () => {
    expect(unwrapDuckDuckGoRedirect('//example.com/page')).toBe(
      'https://example.com/page'
    );
  });

  it('returns empty string for relative paths without uddg', () => {
    expect(unwrapDuckDuckGoRedirect('/about')).toBe('');
  });

  it('handles encoded special characters in destination URL', () => {
    const dest = 'https://example.com/q?x=1&y=2#frag';
    const wrapped = '/l/?uddg=' + encodeURIComponent(dest);
    expect(unwrapDuckDuckGoRedirect(wrapped)).toBe(dest);
  });
});

// ---- parseDuckDuckGoHtml ----------------------------------------------

describe('parseDuckDuckGoHtml', () => {
  it('extracts title, URL, and snippet from each result block', () => {
    const html = makeDuckDuckGoHtml([
      {
        title: 'Asyncio Documentation',
        destUrl: 'https://docs.python.org/3/library/asyncio.html',
        snippet: 'asyncio is a library to write concurrent code',
      },
      {
        title: 'Real Python — Async IO Walkthrough',
        destUrl: 'https://realpython.com/async-io-python/',
        snippet: 'A comprehensive guide to async/await in Python',
      },
    ]);
    const out = parseDuckDuckGoHtml(html);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Asyncio Documentation');
    expect(out[0].url).toBe('https://docs.python.org/3/library/asyncio.html');
    expect(out[0].snippet).toContain('concurrent code');
    expect(out[1].url).toBe('https://realpython.com/async-io-python/');
  });

  it('returns empty array for HTML with no result blocks', () => {
    const html = '<html><body><p>nothing here</p></body></html>';
    expect(parseDuckDuckGoHtml(html)).toEqual([]);
  });

  it('skips DDG-internal links (would point back at duckduckgo.com)', () => {
    // A result whose href points directly at a DDG hostname (no
    // redirector unwrap) should NOT be returned as a real result.
    const html = `
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="https://duckduckgo.com/about">About DuckDuckGo</a>
        </h2>
        <a class="result__snippet">internal link</a>
      </div>
    `;
    expect(parseDuckDuckGoHtml(html)).toEqual([]);
  });

  it('skips ad slots (y.js sponsored URLs)', () => {
    const html = `
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="/y.js?ad_provider=foo&dest=bar">Sponsored Result</a>
        </h2>
        <a class="result__snippet">paid placement</a>
      </div>
    `;
    expect(parseDuckDuckGoHtml(html)).toEqual([]);
  });

  it('collapses multi-whitespace runs in snippet text', () => {
    const html = `
      <div class="result">
        <h2 class="result__title">
          <a class="result__a" href="/l/?uddg=${encodeURIComponent('https://example.com')}">Title</a>
        </h2>
        <a class="result__snippet">multiline\n\n   snippet\twith   tabs</a>
      </div>
    `;
    const out = parseDuckDuckGoHtml(html);
    expect(out[0].snippet).toBe('multiline snippet with tabs');
  });
});

// ---- formatResults -----------------------------------------------------

describe('formatResults', () => {
  it('emits the canonical header line', () => {
    const out = formatResults('python asyncio', [
      {
        title: 'Asyncio Docs',
        url: 'https://docs.python.org/3/library/asyncio.html',
        snippet: 'concurrent code',
      },
    ]);
    expect(out).toMatch(/^Search results for: python asyncio\n/);
    expect(out).toContain('Found 1 result.');
    expect(out).toContain('Asyncio Docs');
    expect(out).toContain('https://docs.python.org/3/library/asyncio.html');
    expect(out).toContain('concurrent code');
  });

  it('pluralizes "results" correctly for N != 1', () => {
    const r2 = formatResults('q', [
      { title: 't1', url: 'https://a.com', snippet: 's1' },
      { title: 't2', url: 'https://b.com', snippet: 's2' },
    ]);
    expect(r2).toContain('Found 2 results.');
  });

  it('returns "No results found." when the list is empty', () => {
    expect(formatResults('q', [])).toBe('Search results for: q\n\nNo results found.');
  });

  it('omits the snippet line when snippet is empty', () => {
    const out = formatResults('q', [
      { title: 't', url: 'https://example.com', snippet: '' },
    ]);
    expect(out).toContain('1. t');
    expect(out).toContain('https://example.com');
    // No phantom blank-snippet line — the formatter should skip it.
    expect(out.split('\n').filter((l) => l === '   ').length).toBe(0);
  });
});

// ---- Input validation --------------------------------------------------

describe('webSearch input validation', () => {
  it('rejects empty query without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await webSearch({ query: '' });
    expect(r).toMatch(/^error: query is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('trims whitespace-only queries', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await webSearch({ query: '   ' });
    expect(r).toMatch(/^error: query is required/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---- HTTP errors -------------------------------------------------------

describe('webSearch HTTP errors', () => {
  it('returns "error: DuckDuckGo returned HTTP nnn" for non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse({ ok: false, status: 503, statusText: 'Service Unavailable', body: '' })
      )
    );
    const r = await webSearch({ query: 'x' });
    expect(r).toMatch(/^error: DuckDuckGo returned HTTP 503/);
  });

  it('classifies AbortError as a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e: any = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      })
    );
    const r = await webSearch({ query: 'x' });
    expect(r).toMatch(/^error: search timed out/);
    expect(r).toContain('"x"');
  });

  it('returns clear error on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    const r = await webSearch({ query: 'x' });
    expect(r).toMatch(/^error: search request failed/);
    expect(r).toContain('ECONNREFUSED');
  });
});

// ---- End-to-end --------------------------------------------------------

describe('webSearch end-to-end', () => {
  it('returns formatted results for a successful DDG response', async () => {
    const html = makeDuckDuckGoHtml([
      {
        title: 'Vitest Documentation',
        destUrl: 'https://vitest.dev/',
        snippet: 'A blazing fast unit test framework powered by Vite.',
      },
      {
        title: 'Vitest GitHub',
        destUrl: 'https://github.com/vitest-dev/vitest',
        snippet: 'A Vite-native testing framework.',
      },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: html })));
    const r = await webSearch({ query: 'vitest' });
    expect(r).toMatch(/^Search results for: vitest/);
    expect(r).toContain('Found 2 results.');
    expect(r).toContain('1. Vitest Documentation');
    expect(r).toContain('https://vitest.dev/');
    expect(r).toContain('2. Vitest GitHub');
    expect(r).toContain('https://github.com/vitest-dev/vitest');
    // Crucially, the model gets the REAL destination URL, not the
    // /l/?uddg= redirector URL — that's the unwrap working.
    expect(r).not.toContain('uddg=');
  });

  it('honors max_results and caps at the hard limit', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `Result ${i}`,
      destUrl: `https://example.com/${i}`,
      snippet: `snippet ${i}`,
    }));
    const html = makeDuckDuckGoHtml(items);
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: html })));

    const r5 = await webSearch({ query: 'q', max_results: 5 });
    // Count numbered "N. " title lines.
    const titles5 = (r5.match(/^\d+\.\s/gm) ?? []).length;
    expect(titles5).toBe(5);

    // max_results=999 → caps at the hard limit (25).
    const rBig = await webSearch({ query: 'q', max_results: 999 });
    const titlesBig = (rBig.match(/^\d+\.\s/gm) ?? []).length;
    expect(titlesBig).toBe(25);
  });

  it('returns "No results found." when DDG returns zero blocks', async () => {
    const html = '<html><body><p>nothing</p></body></html>';
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: html })));
    const r = await webSearch({ query: 'q' });
    expect(r).toContain('No results found.');
  });

  it('passes the query to DDG via POST form-encoded body', async () => {
    const fetchSpy = vi.fn(async () => fakeResponse({ body: makeDuckDuckGoHtml([]) }));
    vi.stubGlobal('fetch', fetchSpy);
    await webSearch({ query: 'rust async runtime' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://html.duckduckgo.com/html/');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('q=rust');
    expect(String(init.body)).toContain('async');
    expect(String(init.body)).toContain('runtime');
  });
});
