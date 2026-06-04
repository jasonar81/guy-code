/**
 * ELECTRON-runtime smoke test for the web tools (WebSearch / WebFetch).
 *
 * WHY THIS EXISTS (and why the node-based scripts/smoke-web-tools.cjs is not
 * enough): WebSearch broke for users with
 *
 *   Error [ERR_REQUIRE_ESM]: require() of ES Module
 *   .../node_modules/@exodus/bytes/encoding-lite.js
 *   from .../node_modules/html-encoding-sniffer/.../html-encoding-sniffer.js
 *
 * That is: a transitive jsdom dependency went ESM-only, and Electron's
 * CommonJS main process can't `require()` an ESM module. The node-based
 * smoke test PASSED anyway, because system Node resolved the dependency
 * differently than Electron's bundled Node does. The lesson: the web tools
 * MUST be smoke-tested in the ACTUAL Electron main-process runtime, loading
 * the BUILT chunk, or we keep shipping this broken.
 *
 * This script IS an Electron main entry. Run it with the project's electron
 * binary:  electron scripts/smoke-web-tools-electron.cjs
 * It loads the built webSearch chunk, constructs a JSDOM, runs the DDG
 * parser, and (best-effort) does a live webSearch. It exits 0 on success and
 * NON-ZERO on any failure — so the release pipeline fails loudly if the web
 * tools can't load in Electron.
 *
 * Headless/CI note: Electron needs a display on Linux; the release workflow
 * wraps this in xvfb-run. We never open a window — app.exit() before that.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

function done(code, msg) {
  if (code === 0) console.log(`[smoke-web-electron] OK — ${msg}`);
  else console.error(`[smoke-web-electron] FAIL — ${msg}`);
  // app.exit avoids opening any window / hanging on the event loop.
  app.exit(code);
}

app.whenReady().then(async () => {
  try {
    const distDir = path.resolve(__dirname, '..', 'dist-electron');
    const files = fs.existsSync(distDir) ? fs.readdirSync(distDir) : [];
    const chunk = files.find((f) => /^webSearch-.*\.js$/.test(f));
    if (!chunk) {
      return done(1, `no webSearch-*.js chunk in ${distDir} (found: ${files.join(', ')})`);
    }

    // THE load that throws ERR_REQUIRE_ESM in Electron when a jsdom dep is
    // ESM-only. This is the whole point of running under Electron.
    const mod = require(path.join(distDir, chunk));
    if (typeof mod.parseDuckDuckGoHtml !== 'function') {
      return done(1, `built chunk missing parseDuckDuckGoHtml (exports: ${Object.keys(mod).join(', ')})`);
    }

    // Construct a JSDOM with CSS (exercises css-tree) + parse fixture HTML.
    const { JSDOM } = require('jsdom');
    const d = new JSDOM('<p id="x">hi</p><style>.a{color:red}</style>', { url: 'https://e.com' });
    if (d.window.document.getElementById('x')?.textContent !== 'hi') {
      return done(1, 'JSDOM constructed but DOM query returned wrong content');
    }

    const parsed = mod.parseDuckDuckGoHtml(
      '<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fok.example%2Fp">T</a>' +
        '<div class="result__snippet">s</div></div>'
    );
    if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0].url !== 'https://ok.example/p') {
      return done(1, `parser returned unexpected output: ${JSON.stringify(parsed)}`);
    }

    // Best-effort live search. Network may be unavailable in some CI
    // sandboxes; a NETWORK failure is NOT a smoke failure (we only care that
    // the code LOADS + RUNS in Electron). But if webSearch throws a
    // module-load error (ERR_REQUIRE_ESM etc.), that IS a failure.
    if (typeof mod.webSearch === 'function') {
      try {
        const r = await mod.webSearch({ query: 'apache license' });
        console.log('[smoke-web-electron] live webSearch returned:', String(r).slice(0, 80).replace(/\n/g, ' '));
      } catch (e) {
        const m = (e && e.message) || String(e);
        if (/ERR_REQUIRE_ESM|Cannot find module|is not supported|not a function/i.test(m)) {
          return done(1, `webSearch threw a load/runtime error in Electron: ${m}`);
        }
        console.log('[smoke-web-electron] live webSearch failed (network — tolerated):', m.slice(0, 100));
      }
    }

    return done(0, 'web tools load + run in the Electron main runtime.');
  } catch (e) {
    return done(1, `threw in Electron: ${(e && e.stack) || e}`);
  }
});
