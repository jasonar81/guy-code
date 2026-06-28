import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Vitest config — separate from `vite.config.ts` so the test runner
 * doesn't pull in the `vite-plugin-electron` plugin (which spins up an
 * Electron dev process on import). We only need React + the path
 * alias here.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    // Run all tests in tests/ + colocated *.test.ts(x) files anywhere
    // under src/ or electron/.
    include: [
      'tests/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
      'electron/**/*.test.{ts,tsx}',
    ],
    // happy-dom is the leanest DOM impl that satisfies React Testing
    // Library; jsdom is heavier and we don't need its extra surface.
    environment: 'happy-dom',
    // Global setup: jest-dom matchers for component tests.
    setupFiles: ['./tests/setup.ts'],
    // Fail fast on uncaught console.error during tests — usually
    // surfaces React rendering bugs.
    onConsoleLog(log, type) {
      if (type === 'stderr' && log.includes('act(')) return false;
      return undefined;
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'electron/**/*.ts',
        'src/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/preload.ts',
        '**/main.tsx',
      ],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // happy-dom can't process a real stylesheet (and KaTeX warns/blanks the
      // render in quirks mode), so stub out CSS imports in tests.
      'katex/dist/katex.min.css': resolve(__dirname, 'tests/stubs/empty-css.ts'),
    },
  },
});
