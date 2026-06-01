/**
 * GUARDRAIL: web tools (WebSearch / WebFetch) must be able to load jsdom and
 * parse HTML. These tools have broken MORE THAN ONCE when jsdom's CSS
 * dependency (`css-tree`) failed to resolve its runtime data file
 * (`../data/patch.json`) after a bundling/packaging change. The failure mode
 * is silent at build time and only shows up when a user runs WebSearch.
 *
 * This test exercises the real jsdom-backed parse path (`parseDuckDuckGoHtml`
 * constructs a JSDOM and queries the DOM). If jsdom can't load — for ANY
 * reason, including the css-tree patch.json regression — this test throws
 * and the whole suite (which CI gates the release on) goes red. That makes
 * "shipped WebSearch broken" impossible to miss again.
 *
 * Note: this catches SOURCE/dev breakage (jsdom unresolvable in the build
 * graph). The complementary PACKAGED-asar smoke test lives in the release
 * workflow (scripts/smoke-web-tools.cjs) for the "works in dev, breaks once
 * packed" class.
 */
import { describe, expect, it } from 'vitest';
import { parseDuckDuckGoHtml, unwrapDuckDuckGoRedirect } from '../electron/webSearch';
import { JSDOM } from 'jsdom';

describe('web tools jsdom guardrail', () => {
  it('jsdom loads and parses HTML with CSS (css-tree patch.json reachable)', () => {
    // The css-tree patch.json regression specifically blew up when a
    // <style> block forced CSS parsing. Include one so we hit that path.
    const dom = new JSDOM(
      '<html><body><p id="x">hello</p><style>.a{color:red}</style></body></html>',
      { url: 'https://example.com' }
    );
    expect(dom.window.document.getElementById('x')?.textContent).toBe('hello');
  });

  it('parseDuckDuckGoHtml extracts results from fixture HTML (real jsdom path)', () => {
    const html = `
      <html><body>
        <div class="result results_links">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Fpage&rut=abc">Example Title</a>
          <div class="result__snippet">An example snippet describing the page.</div>
        </div>
        <div class="result results_links">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide">Docs Guide</a>
          <a class="result__snippet" href="#">Second result snippet.</a>
        </div>
      </body></html>`;
    const results = parseDuckDuckGoHtml(html);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('Example Title');
    expect(results[0].url).toBe('https://example.org/page');
    expect(results[0].snippet).toContain('example snippet');
    expect(results[1].url).toBe('https://docs.example.com/guide');
  });

  it('unwrapDuckDuckGoRedirect resolves the uddg redirect param', () => {
    expect(
      unwrapDuckDuckGoRedirect('/l/?uddg=https%3A%2F%2Ffoo.com%2Fbar&rut=x')
    ).toBe('https://foo.com/bar');
  });

  it('parseDuckDuckGoHtml returns [] for empty/garbage HTML without throwing', () => {
    expect(parseDuckDuckGoHtml('')).toEqual([]);
    expect(parseDuckDuckGoHtml('<html></html>')).toEqual([]);
  });
});
