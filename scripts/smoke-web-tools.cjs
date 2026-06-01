#!/usr/bin/env node
/**
 * Post-build smoke test for the web tools (WebSearch / WebFetch).
 *
 * WHY: these tools have shipped broken more than once because jsdom's CSS
 * dependency (css-tree) couldn't resolve its runtime data file
 * (`../data/patch.json`) after a bundling/packaging change. That failure is
 * invisible at build time — `npm run build` succeeds, the unit tests pass
 * (they import from the source tree, where node_modules resolves fine) — and
 * only surfaces when a user actually runs WebSearch in the packaged app.
 *
 * This script closes that gap by loading the BUILT main-process chunks the
 * way Electron's real `require()` does (from dist-electron/, resolving
 * externalized modules like jsdom from node_modules) and exercising the
 * jsdom-backed parse path. If jsdom can't load — including the css-tree
 * patch.json regression — this exits non-zero and fails the release.
 *
 * Run AFTER `npm run build`, BEFORE/at packaging time. Wired into
 * .github/workflows/release.yml as a required step.
 *
 * Usage: node scripts/smoke-web-tools.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const distDir = path.join(ROOT, 'dist-electron');

function fail(msg) {
  console.error(`\n[smoke-web-tools] FAIL: ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(distDir)) {
  fail(`dist-electron not found at ${distDir} — run "npm run build" first.`);
}

// Locate the built webSearch chunk (hashed filename). It's emitted as a
// separate chunk because electron/webSearch.ts is a distinct entry in the
// import graph.
const files = fs.readdirSync(distDir);
const webSearchChunk = files.find((f) => /^webSearch-.*\.js$/.test(f));
if (!webSearchChunk) {
  fail(
    `no webSearch-*.js chunk in dist-electron (found: ${files.join(', ')}). ` +
      `Did the build output layout change?`
  );
}

console.log(`[smoke-web-tools] loading built chunk: ${webSearchChunk}`);

let mod;
try {
  // This is the load that breaks when jsdom/css-tree can't resolve its data
  // files in the built layout — exactly the user-facing regression.
  mod = require(path.join(distDir, webSearchChunk));
} catch (e) {
  fail(
    `requiring the built webSearch chunk threw — this is the packaging ` +
      `regression that breaks WebSearch/WebFetch for users:\n  ${e && e.message}`
  );
}

if (typeof mod.parseDuckDuckGoHtml !== 'function') {
  fail(
    `built chunk does not export parseDuckDuckGoHtml (exports: ${Object.keys(mod).join(', ')}).`
  );
}

// Exercise the real jsdom path: parse fixture HTML that includes a <style>
// block (forces css-tree, the thing that regressed).
const fixture = `
  <html><body>
    <style>.a{color:red}</style>
    <div class="result results_links">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Fpage&rut=z">T</a>
      <div class="result__snippet">snippet</div>
    </div>
  </body></html>`;

let results;
try {
  results = mod.parseDuckDuckGoHtml(fixture);
} catch (e) {
  fail(`parseDuckDuckGoHtml threw (jsdom/css-tree load failure?):\n  ${e && e.message}`);
}

if (!Array.isArray(results) || results.length !== 1 || results[0].url !== 'https://example.org/page') {
  fail(`parseDuckDuckGoHtml returned unexpected output: ${JSON.stringify(results)}`);
}

// Also directly construct a JSDOM to be unambiguous about jsdom health.
try {
  const { JSDOM } = require('jsdom');
  const d = new JSDOM('<p>x</p><style>.b{color:blue}</style>', { url: 'https://e.com' });
  if (d.window.document.body.textContent.indexOf('x') === -1) {
    fail('JSDOM constructed but DOM query returned wrong content.');
  }
} catch (e) {
  fail(`direct JSDOM construction failed:\n  ${e && e.message}`);
}

console.log('[smoke-web-tools] OK — web tools (jsdom + DDG parser) load and work in the built output.\n');
process.exit(0);
