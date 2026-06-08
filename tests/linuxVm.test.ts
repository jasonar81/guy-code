/**
 * Tests for the Linux-VM app-automation mode: the mode-aware backend factory,
 * the AppLaunch `mode` param + tool routing, and the WSL provisioning helpers'
 * pure logic. These don't need a real WSL/VM (the end-to-end behavior is
 * validated against real WSL during development).
 */
import { describe, expect, it } from 'vitest';

describe('appAutomation defaultMode', () => {
  it('defaults to native on win32/linux and linux-vm on darwin', async () => {
    const mod = await import('../electron/appAutomation');
    // We can't change process.platform reliably mid-test across the import
    // cache, so assert the function reflects the current platform consistently.
    const m = mod.defaultMode();
    if (process.platform === 'darwin') expect(m).toBe('linux-vm');
    else expect(m).toBe('native');
  });
});

describe('AppLaunch tool exposes the mode param + linux-vm docs', () => {
  it('AppLaunch input_schema has a mode enum of native|linux-vm', async () => {
    const { TOOLS } = await import('../electron/tools');
    const props = (TOOLS['AppLaunch'].schema.input_schema as any).properties;
    expect(props.mode).toBeTruthy();
    expect(props.mode.enum).toEqual(['native', 'linux-vm']);
  });

  it('AppLaunch description explains native vs linux-vm + games/macOS', async () => {
    const { TOOLS } = await import('../electron/tools');
    const d = TOOLS['AppLaunch'].schema.description;
    expect(d).toMatch(/linux-vm/);
    expect(d).toMatch(/games|emulator/i);
    expect(d).toMatch(/macOS/i);
  });
});

describe('getBackend(mode) on this platform', () => {
  it('returns null for native on macOS, a backend otherwise', async () => {
    const { getBackend } = await import('../electron/appAutomation');
    const native = await getBackend('native');
    if (process.platform === 'darwin') {
      expect(native).toBeNull();
    } else {
      expect(native).toBeTruthy();
      expect(['win32', 'linux']).toContain((native as any).platform);
    }
  });

  it('linux-vm backend is constructable on win32/darwin/linux', async () => {
    const { getBackend } = await import('../electron/appAutomation');
    const vm = await getBackend('linux-vm');
    // On all three supported host platforms a linux-vm backend object exists
    // (its preflight will report if WSL/VM isn't set up).
    expect(vm).toBeTruthy();
  });
});

describe('wslProvision pure helpers', () => {
  it('shellQuote single-quotes and escapes embedded quotes', async () => {
    const { shellQuote } = await import('../electron/wslProvision');
    expect(shellQuote('hello')).toBe(`'hello'`);
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('exposes the package + app lists', async () => {
    const { WSL_PACKAGES, WSL_APPS } = await import('../electron/wslProvision');
    expect(WSL_PACKAGES).toContain('xvfb');
    expect(WSL_PACKAGES).toContain('xdotool');
    expect(WSL_APPS.length).toBeGreaterThan(0);
  });
});
