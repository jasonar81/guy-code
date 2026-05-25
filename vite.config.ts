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
              // sql.js and electron-log both use Node-native paths or
              // dynamic require() under the hood and must NOT be
              // bundled through Rollup — they're loaded directly from
              // node_modules at runtime by Electron's real `require()`.
              // (playwright-core lived here previously for the same
              // reason; the Chrome connector is now extension-based
              // and no longer imports it, so it's been removed.)
              external: ['sql.js', 'electron-log'],
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
              external: ['sql.js', 'electron-log'],
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
