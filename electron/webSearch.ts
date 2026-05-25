/**
 * WebSearch tool — local DuckDuckGo HTML search.
 *
 * Replaces the server-side `web_search_20250305` Anthropic tool, which
 * is gated per-organization (orgs that haven't enabled it get a 400
 * "Web search is not enabled for this organization" on every turn the
 * tool is registered). A local implementation works for every user,
 * doesn't bill against Anthropic's per-search fee, and runs in the
 * Electron main process where we already have outbound HTTP.
 *
 * Backend: DuckDuckGo's HTML endpoint at
 * `https://html.duckduckgo.com/html/?q=<query>`. Chosen because:
 *   • No API key. No signup. No quota gate.
 *   • Returns plain HTML with stable, parseable result blocks.
 *   • Does not require JS execution — JSDOM handles it.
 *   • Reasonable result quality (DDG aggregates multiple sources).
 *
 * Trade-offs vs Anthropic's server-side search:
 *   • Quality: roughly equivalent for general queries; slightly worse
 *     for very recent news (DDG indexing lag is a few hours).
 *   • Format: we return title + URL + snippet for each hit, no inline
 *     citations. The model can call WebFetch on any URL to get the
 *     full page if a snippet isn't enough.
 *   • Speed: one HTTP round-trip + parse, ~500-1500ms for 10 results.
 *
 * Hard limits (intentional, mirror WebFetch):
 *   • 15-second timeout.
 *   • 5 MB body cap.
 *   • Top 10 results returned by default; capped at 25.
 */
import log from 'electron-log';
import { JSDOM } from 'jsdom';

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_RESULTS = 10;
const HARD_MAX_RESULTS = 25;

export interface WebSearchInput {
  query: string;
  /**
   * Maximum number of results to return. Defaults to 10. Hard-capped
   * at 25 — beyond that the search-results page splits into multiple
   * paginated requests and the model rarely benefits from a deeper
   * crawl over just calling WebFetch on the most relevant hit.
   */
  max_results?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Pure parser, exported for tests. Takes the raw HTML returned by
 * DuckDuckGo's `/html/` endpoint and produces a list of structured
 * results. Tolerant of small DOM changes — the .result__a / .result__snippet
 * class names have been stable for years, but if DDG drops them this
 * function is the single point to update.
 */
export function parseDuckDuckGoHtml(html: string, baseUrl = 'https://html.duckduckgo.com'): SearchResult[] {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url: baseUrl });
  } catch (e: any) {
    log.warn('[webSearch] jsdom parse failed', e);
    return [];
  }
  const doc = dom.window.document;
  // DDG wraps each result in `.result` (sometimes `.result.results_links`).
  // We pick the title/snippet by their class names rather than position so
  // the parser keeps working when DDG reshuffles internal layout.
  const blocks = Array.from(doc.querySelectorAll('.result, .web-result'));
  const out: SearchResult[] = [];
  for (const block of blocks) {
    const titleEl = block.querySelector('.result__a, .result__title a, a.result__a');
    if (!titleEl) continue;
    const rawHref = (titleEl as HTMLAnchorElement).getAttribute('href') ?? '';
    const url = unwrapDuckDuckGoRedirect(rawHref);
    if (!url) continue;
    const title = (titleEl.textContent ?? '').trim();
    const snippetEl = block.querySelector('.result__snippet, .result__body');
    const snippet = (snippetEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    // Skip ads and DDG's own internal links — they show up with hrefs
    // pointing back to duckduckgo.com or to /y.js (sponsored slots).
    if (/^https?:\/\/(?:duckduckgo|html\.duckduckgo)\.com\//i.test(url)) continue;
    if (rawHref.startsWith('/y.js') || rawHref.includes('y.js?ad_')) continue;
    out.push({ title, url, snippet });
  }
  return out;
}

/**
 * DuckDuckGo wraps result links through a redirector at
 * `/l/?uddg=<urlencoded final URL>&rut=...` so it can track click-through
 * without leaking the user's original query to the destination via the
 * Referer header. We strip that wrapper to give the model the actual
 * destination URL — otherwise WebFetch would have to follow another hop
 * and the URL the model echoes back to the user looks like a tracking
 * link, which is confusing.
 *
 * Returns the unwrapped URL, or '' if `href` doesn't look like a usable
 * link (relative anchor, mailto, javascript:, etc.).
 *
 * Exported for tests so we can pin the unwrap behavior without making
 * a real network round-trip.
 */
export function unwrapDuckDuckGoRedirect(href: string): string {
  if (!href) return '';
  let url = href.trim();
  // Protocol-relative links — DDG sometimes uses `//html.duckduckgo.com/...`.
  if (url.startsWith('//')) url = 'https:' + url;
  // Relative redirector path: `/l/?uddg=...`. Resolve against DDG host.
  if (url.startsWith('/')) {
    try {
      const absolute = new URL(url, 'https://html.duckduckgo.com');
      const uddg = absolute.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
      // Some DDG variants use `u3=` for the final URL on certain layouts.
      const u3 = absolute.searchParams.get('u3');
      if (u3) return decodeURIComponent(u3);
      return '';
    } catch {
      return '';
    }
  }
  // Absolute URL — already pointing at the destination, just return it.
  // (Older DDG layouts and some response variants give us absolute hrefs.)
  if (/^https?:\/\//i.test(url)) {
    // Some absolute URLs ALSO go through the redirector (e.g.
    // `https://duckduckgo.com/l/?uddg=...`). Unwrap those too.
    try {
      const parsed = new URL(url);
      if (
        /(?:^|\.)duckduckgo\.com$/i.test(parsed.hostname) &&
        parsed.pathname === '/l/' &&
        parsed.searchParams.has('uddg')
      ) {
        return decodeURIComponent(parsed.searchParams.get('uddg') as string);
      }
      return url;
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Format the structured result list as a single string for the model.
 * Each result is printed as a numbered block with title, URL, and
 * snippet on their own lines. The header line ("Search results for: …")
 * is recognized by the `webSearchSummary` summarizer (added below) so
 * it survives truncation when the result body is too large.
 *
 * Exported for tests.
 */
export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `Search results for: ${query}\n\nNo results found.`;
  }
  const lines: string[] = [
    `Search results for: ${query}`,
    `Found ${results.length} result${results.length === 1 ? '' : 's'}.`,
    '',
  ];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd() + '\n';
}

export async function webSearch(input: WebSearchInput): Promise<string> {
  const query = (input.query ?? '').trim();
  if (!query) return 'error: query is required';
  const requested = Number.isFinite(input.max_results)
    ? Math.max(1, Math.floor(input.max_results as number))
    : DEFAULT_MAX_RESULTS;
  const maxResults = Math.min(requested, HARD_MAX_RESULTS);

  // We use POST to DDG's /html/ endpoint because the GET variant
  // sometimes serves a JS-only landing page asking the user to confirm
  // they're not a bot. POST with form-encoded `q` consistently returns
  // the parseable HTML directly. (Verified against duckduckgo.com
  // response patterns as of 2026.)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Guy Code WebSearch; +https://github.com/jasonar81/guy-code)',
        accept: 'text/html,application/xhtml+xml',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      return `error: search timed out after ${TIMEOUT_MS}ms for query "${query}"`;
    }
    return `error: search request failed: ${e?.message ?? String(e)}`;
  }
  clearTimeout(timer);

  if (!response.ok) {
    return `error: DuckDuckGo returned HTTP ${response.status} ${response.statusText}`;
  }

  // Stream-with-cap, mirroring webFetch.ts. DDG's /html/ response is
  // typically 50-200 KB so the cap should never trigger in practice,
  // but we keep it for defense in depth.
  let bodyBytes = 0;
  const chunks: Uint8Array[] = [];
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bodyBytes += value.byteLength;
      if (bodyBytes > MAX_BODY_BYTES) {
        try {
          reader.cancel();
        } catch {
          /* ignore */
        }
        return `error: search response exceeded ${MAX_BODY_BYTES.toLocaleString()} byte cap`;
      }
      chunks.push(value);
    }
  }
  const buffer = Buffer.concat(chunks.map((u) => Buffer.from(u)));
  const html = buffer.toString('utf8');

  const results = parseDuckDuckGoHtml(html, response.url || 'https://html.duckduckgo.com').slice(0, maxResults);
  return formatResults(query, results);
}
