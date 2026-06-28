/**
 * Global test setup. Imported by every test file via the `setupFiles`
 * entry in `vitest.config.ts`.
 *
 * - Wires `@testing-library/jest-dom` matchers (toBeInTheDocument,
 *   toHaveTextContent, etc.) onto Vitest's expect.
 * - Stubs `electron-log` since most modules under test import it
 *   transitively but we don't want a hard dep on the Electron runtime.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// happy-dom defaults to QUIRKS mode without a doctype, which makes KaTeX warn
// and bail (blanking any component that renders math via rehype-katex - and
// even components that just import it). Force standards mode by attaching a
// doctype so KaTeX renders normally in tests.
try {
  if (typeof document !== 'undefined' && !document.doctype) {
    document.insertBefore(
      document.implementation.createDocumentType('html', '', ''),
      document.documentElement
    );
  }
} catch {
  /* non-DOM test environment; ignore */
}

// React Testing Library's auto-cleanup is wired through the Jest
// global hook; under Vitest we have to register it explicitly so DOM
// state doesn't bleed between component tests (which produced
// "multiple elements found" failures in CurrentPlanPanel.test.tsx).
afterEach(() => {
  cleanup();
});

// `electron-log` checks `process.versions.electron` on import; in a
// pure-Node Vitest environment it falls through to a console-only
// transport, which is fine. But its `initialize()` call writes to a
// log file path computed from app.getPath('userData') — which throws
// because we're not in Electron. Stub the module entirely so any
// `log.info`, `log.error`, etc. become no-ops in tests.
vi.mock('electron-log', () => {
  const noop = () => {};
  const stub: Record<string, unknown> = {
    initialize: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    log: noop,
    verbose: noop,
    silly: noop,
    transports: {
      file: { level: false, fileName: 'test' },
      console: { level: false },
    },
  };
  // electron-log's default export is the logger itself.
  return { default: stub, ...stub };
});
