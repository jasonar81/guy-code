/**
 * Tests for the Chrome-extension build-version handshake / staleness check.
 *
 * Two things matter:
 *  1. The app's EXTENSION_BUILD (electron/extVersion.ts) and the extension's
 *     EXT_BUILD (chrome-extension/service_worker.js) MUST stay in lockstep —
 *     if they drift, the app would falsely flag a current extension as stale
 *     (or fail to flag a real stale one). This test parses both and asserts
 *     equality so the lockstep can't silently break.
 *  2. isExtensionStale's rule: only meaningful while connected; a null build
 *     (extension predates the handshake) counts as stale; an older build is
 *     stale; an equal/newer build is current.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_BUILD, isExtensionStale } from '../electron/extVersion';

describe('extension build version lockstep', () => {
  it('EXTENSION_BUILD (app) matches EXT_BUILD (service_worker.js)', () => {
    const sw = readFileSync(
      join(__dirname, '..', 'chrome-extension', 'service_worker.js'),
      'utf8'
    );
    const m = /const\s+EXT_BUILD\s*=\s*(\d+)\s*;/.exec(sw);
    expect(m, 'EXT_BUILD constant not found in service_worker.js').toBeTruthy();
    const extBuild = Number(m![1]);
    expect(extBuild).toBe(EXTENSION_BUILD);
  });

  it('hello message includes extBuild', () => {
    const sw = readFileSync(
      join(__dirname, '..', 'chrome-extension', 'service_worker.js'),
      'utf8'
    );
    // The hello payload must carry extBuild so the bridge can read it.
    expect(/type:\s*'hello'[\s\S]{0,120}extBuild:\s*EXT_BUILD/.test(sw)).toBe(true);
  });
});

describe('isExtensionStale', () => {
  it('is false when not connected (no warning while disconnected)', () => {
    expect(isExtensionStale('disconnected', null, 2)).toBe(false);
    expect(isExtensionStale('connecting', 1, 2)).toBe(false);
    expect(isExtensionStale('error', 1, 2)).toBe(false);
  });

  it('is true when connected and the extension reports no build (pre-handshake)', () => {
    expect(isExtensionStale('connected', null, 2)).toBe(true);
  });

  it('is true when connected and the extension build is older', () => {
    expect(isExtensionStale('connected', 1, 2)).toBe(true);
  });

  it('is false when connected and the extension build is current or newer', () => {
    expect(isExtensionStale('connected', 2, 2)).toBe(false);
    expect(isExtensionStale('connected', 3, 2)).toBe(false);
  });

  it('defaults the expected build to EXTENSION_BUILD', () => {
    expect(isExtensionStale('connected', EXTENSION_BUILD)).toBe(false);
    expect(isExtensionStale('connected', EXTENSION_BUILD - 1)).toBe(true);
  });
});
