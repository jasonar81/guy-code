import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // These packages use Node-native paths or dynamic
              // require() under the hood and must NOT be bundled through
              // Rollup — they're loaded directly from node_modules at
              // runtime by Electron's real `require()`.
              //   • sql.js — ships a .wasm loaded by path.
              //   • electron-log — resolves its own transport paths.
              //   • jsdom — its CSS dependency `css-tree` does
              //     `require('../data/patch.json')` (and `mdn-data/*.json`)
              //     at runtime relative to its own on-disk location. When
              //     bundled into dist-electron/api-*.js those relative
              //     requires resolve against dist-electron/ instead of
              //     node_modules/css-tree/cjs/ and throw
              //     "Cannot find module '../data/patch.json'", which broke
              //     WebFetch + WebSearch (both import jsdom). Externalizing
              //     jsdom makes the requires resolve from its real location
              //     inside the asar's node_modules, where the data files
              //     ship correctly. (playwright-core lived here previously
              //     for the same class of reason; removed when the Chrome
              //     connector became extension-based.)
              external: ['sql.js', 'electron-log', 'jsdom'],
            },
          },
        },
      },
      preload: {
        input: resolve(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['sql.js', 'electron-log', 'jsdom'],
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
  },
});
