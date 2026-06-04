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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

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

  /**
   * STRUCTURAL guard against the ERR_REQUIRE_ESM regression that broke
   * WebSearch in the packaged app (a jsdom transitive dep — @exodus/bytes via
   * html-encoding-sniffer@6 / whatwg-url@16 — became ESM-only, which
   * Electron's CommonJS main process can't `require()`). The jsdom-import
   * tests above DON'T catch this (Node tolerates it where Electron doesn't),
   * so we assert the dependency tree itself stays CommonJS-loadable: no
   * package jsdom pulls in may be ESM-only (`"type": "module"` with no CJS
   * `require` export / `main`).
   *
   * If this fails, a jsdom upgrade re-introduced an ESM-only transitive dep —
   * pin jsdom (or the dep) back to a CJS-compatible version. See
   * guycode-websearch-electron-runtime-bug memory.
   */
  it('jsdom dependency tree has no ESM-only package (would ERR_REQUIRE_ESM in Electron)', () => {
    const req = createRequire(import.meta.url);
    let jsdomPkgPath: string;
    try {
      jsdomPkgPath = req.resolve('jsdom/package.json');
    } catch {
      // jsdom not resolvable as a subpath — fall back to main entry's dir.
      jsdomPkgPath = join(dirname(req.resolve('jsdom')), 'package.json');
    }
    const jsdomRoot = dirname(jsdomPkgPath);
    const nodeModulesRoot = dirname(dirname(jsdomPkgPath).endsWith('jsdom') ? dirname(jsdomPkgPath) : jsdomRoot);

    // Walk jsdom + the flat node_modules siblings it can resolve. A package
    // is "ESM-only" (and thus un-`require()`-able from CJS) when it declares
    // "type":"module" AND offers no CommonJS entry: no "main", and its
    // "exports" don't expose a `require` condition.
    const offenders: string[] = [];
    const seen = new Set<string>();

    const isEsmOnly = (pkgJson: any): boolean => {
      if (pkgJson?.type !== 'module') return false;
      // A "main" field is treated as a CJS entry only if it's not clearly mjs.
      if (typeof pkgJson.main === 'string' && !pkgJson.main.endsWith('.mjs')) return false;
      const exp = pkgJson.exports;
      const hasRequire = (node: any): boolean => {
        if (!node || typeof node !== 'object') return false;
        if ('require' in node) return true;
        return Object.values(node).some((v) => hasRequire(v));
      };
      if (exp && hasRequire(exp)) return false;
      return true;
    };

    const visit = (pkgDir: string) => {
      const pj = join(pkgDir, 'package.json');
      if (!existsSync(pj) || seen.has(pj)) return;
      seen.add(pj);
      let meta: any;
      try {
        meta = JSON.parse(readFileSync(pj, 'utf8'));
      } catch {
        return;
      }
      if (isEsmOnly(meta)) offenders.push(`${meta.name}@${meta.version} (${pkgDir})`);
      const deps = Object.keys(meta.dependencies ?? {});
      for (const dep of deps) {
        // Resolve the dep relative to this package, then walk it.
        const candidates = [
          join(pkgDir, 'node_modules', dep),
          join(nodeModulesRoot, dep),
        ];
        for (const c of candidates) {
          if (existsSync(join(c, 'package.json'))) {
            visit(c);
            break;
          }
        }
      }
    };

    visit(jsdomRoot);
    expect(offenders, `ESM-only packages in jsdom's tree (break Electron require()): ${offenders.join('; ')}`).toEqual([]);
    // Sanity: we actually walked a non-trivial tree.
    expect(seen.size).toBeGreaterThan(5);
    // Belt-and-suspenders: the specific package that bit us must be absent.
    expect(existsSync(join(nodeModulesRoot, '@exodus', 'bytes'))).toBe(false);
    void statSync; // keep import used if tree-walk short-circuits
    void readdirSync;
  });
});
