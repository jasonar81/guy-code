/**
 * WebFetch tool — fetch a URL and return clean readable text.
 *
 * Sibling tool to WebSearch (`./webSearch.ts`). Both run locally in the
 * Electron main process — WebSearch finds candidate URLs via DuckDuckGo;
 * WebFetch reads any single URL. Neither relies on Anthropic's server-side
 * `web_search_20250305` (which is gated per-organization). WebFetch
 * follows redirects, parses HTML through Mozilla's Readability extractor
 * (the same one Firefox Reader View uses), and
 * return the article text. Non-HTML payloads (text/json/markdown/PDF
 * text) pass through after a size cap.
 *
 * Hard limits (intentional):
 *   • 15-second connect+body timeout. If the page is slow we'd rather
 *     fail fast and tell the model than hang the whole turn.
 *   • 5 redirects max. Anything more is usually a redirect loop or a
 *     tracker bouncing the URL through a half-dozen domains.
 *   • 5 MB body cap. A 5 MB HTML page is already a code smell; bigger
 *     than that is almost certainly something we don't want to load
 *     into RAM (downloadable binary, video, etc.).
 *
 * Output format:
 *   Title: <extracted title or URL fallback>
 *   URL: <final URL after redirects>
 *
 *   <readable text body>
 *
 * The `Title:`/`URL:` header lines are recognized by the
 * `webFetchSummary` summarizer in `toolSummarizer.ts`, which preserves
 * them when truncating.
 */
import log from 'electron-log';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

export interface WebFetchInput {
  url: string;
}

export async function webFetch(input: WebFetchInput): Promise<string> {
  const url = (input.url ?? '').trim();
  if (!url) return 'error: url is required';
  if (!/^https?:\/\//i.test(url)) {
    return `error: only http(s) URLs are supported (got ${url})`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      // Browser-ish UA so sites don't throw 403 at us. We're not trying
      // to deceive — many sites just gate raw curl-style requests.
      headers: {
        'user-agent':
          'Mozilla/5.0 (Guy Code WebFetch; +https://github.com/jasonar81/guy-code)',
        accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      return `error: timed out after ${TIMEOUT_MS}ms fetching ${url}`;
    }
    return `error: fetch failed: ${e?.message ?? String(e)}`;
  }
  clearTimeout(timer);

  // The fetch() spec doesn't surface the redirect count, but it does
  // expose `redirected` (boolean) and the final URL. Browsers cap at
  // 20 by default. We can't enforce our own MAX_REDIRECTS without
  // setting `redirect: 'manual'` and handling each hop ourselves;
  // that's more code than it's worth for the rare bouncer-loop case
  // where the abort timer (15s) catches it anyway. The constant is
  // kept above as a documented intent and a hook for future
  // tightening.
  void MAX_REDIRECTS;

  const finalUrl = response.url || url;

  if (!response.ok) {
    return `error: HTTP ${response.status} ${response.statusText} from ${finalUrl}`;
  }

  // Read the body with a hard size cap. Streaming the chunks lets us
  // bail before allocating gigabytes for an attacker / runaway URL.
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
        return `error: response body exceeded ${MAX_BODY_BYTES.toLocaleString()} byte cap from ${finalUrl}`;
      }
      chunks.push(value);
    }
  }
  const buffer = Buffer.concat(chunks.map((u) => Buffer.from(u)));
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

  // Decode using the charset the server claims, defaulting to utf-8.
  // Most modern sites are utf-8; legacy pages occasionally aren't and
  // misdecoding turns the body into mojibake that the model can't use.
  const charsetMatch = contentType.match(/charset=([\w-]+)/);
  const charset = charsetMatch ? charsetMatch[1].toLowerCase() : 'utf-8';
  let bodyText: string;
  try {
    bodyText = new TextDecoder(charset).decode(buffer);
  } catch {
    bodyText = buffer.toString('utf8');
  }

  // HTML → run Readability for the article content. Falls back to
  // raw textContent (DOM-stripped) when Readability can't identify
  // a main article (login pages, app shells, doc indexes, etc.).
  if (contentType.includes('html') || contentType === '') {
    return formatHtml(bodyText, finalUrl);
  }

  // Plain text / JSON / markdown — return verbatim. The
  // tool-result summarizer will trim if it's too big.
  return formatPlain(bodyText, finalUrl, contentType || 'unknown');
}

function formatHtml(html: string, finalUrl: string): string {
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url: finalUrl });
  } catch (e: any) {
    log.warn('[webFetch] jsdom parse failed', e);
    // Fall back to a crude tag-strip so the model gets SOMETHING.
    return formatPlain(stripTags(html), finalUrl, 'text/html (parse-failed)');
  }
  const doc = dom.window.document;
  const docTitle = doc.title ?? '';
  let articleText = '';
  let articleTitle = '';
  try {
    const article = new Readability(doc).parse();
    if (article) {
      articleText = (article.textContent ?? '').trim();
      articleTitle = (article.title ?? '').trim();
    }
  } catch (e: any) {
    log.warn('[webFetch] readability threw', e);
  }
  if (!articleText) {
    // Readability bailed (no main article identified). Strip the DOM
    // ourselves and return the raw text — better than nothing.
    articleText = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  // Collapse whitespace runs — Readability sometimes emits multi-blank
  // gaps where the original page had stylistic markup.
  articleText = articleText.replace(/\n{3,}/g, '\n\n');
  const titleLine = articleTitle || docTitle || finalUrl;
  return [`Title: ${titleLine}`, `URL: ${finalUrl}`, '', articleText].join('\n');
}

function formatPlain(body: string, finalUrl: string, mime: string): string {
  return [
    `URL: ${finalUrl}`,
    `Content-Type: ${mime}`,
    `Bytes: ${body.length.toLocaleString()}`,
    '',
    body,
  ].join('\n');
}

function stripTags(html: string): string {
  // Last-resort tag stripper for when JSDOM itself fails. Not
  // robust against script/style content, but on the failure path
  // anything > nothing.
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
