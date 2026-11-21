// Bundle the plugin into dist/ (design 7.1): daemon.js, mcp.js, hook.js,
// cli.js and sql-wasm.wasm. Run from the guy-code repo root:
//
//   node integrations/claude-code-a2a/plugins/a2a-peer/build.mjs
//
// esbuild inlines Guy Code's electron/a2a modules (through
// src/shared/protocol.ts), the MCP SDK and sql.js, so the installed plugin
// needs nothing but `node` (>= 20) and no `npm install`. Electron is never
// imported by any of these entry points; the build fails if it is.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const require = createRequire(import.meta.url);
mkdirSync(out, { recursive: true });

await build({
  entryPoints: ['daemon', 'mcp', 'hook', 'cli'].map((n) => join(here, 'src', `${n}.ts`)),
  outdir: out,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  // Fail loudly rather than ship a plugin that tries to load Electron.
  external: [],
  plugins: [
    {
      name: 'no-electron',
      setup(b) {
        b.onResolve({ filter: /^(electron|electron-log)(\/.*)?$/ }, (a) => ({ errors: [{ text: `a2a-peer must not import ${a.path} (from ${a.importer})` }] }));
      },
    },
  ],
});

copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), join(out, 'sql-wasm.wasm'));
console.log(`a2a-peer built into ${out}`);
