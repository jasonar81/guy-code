/**
 * Tests for the app-automation layer (launch/control GUI apps in an isolated
 * display). These exercise the platform-agnostic pieces — the backend factory,
 * id generation, the shared handle registry, and the tool schemas — without
 * needing a real Xvfb server or Windows desktop (those are validated by the
 * helper smoke test + manual prototypes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, BaseBackend, teardownAllAutomation } from '../electron/appAutomation';
import type { AppHandle } from '../electron/appAutomation';

describe('newId', () => {
  it('produces unique prefixed ids', () => {
    const a = newId('app');
    const b = newId('app');
    expect(a).toMatch(/^app_[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('BaseBackend handle registry', () => {
  class TestBackend extends BaseBackend {
    add(h: AppHandle) {
      this.register(h);
    }
    get(appId: string) {
      return this.getHandle(appId);
    }
    drop(appId: string) {
      this.unregister(appId);
    }
  }

  it('registers, retrieves, and drops handles', () => {
    const b = new TestBackend();
    const h: AppHandle = { appId: 'app_x', sessionId: 's1', pid: 123, command: 'foo' };
    b.add(h);
    expect(b.get('app_x')).toBe(h);
    b.drop('app_x');
    expect(() => b.get('app_x')).toThrow(/unknown app handle/);
  });

  it('throws a clear error for an unknown handle', () => {
    const b = new TestBackend();
    expect(() => b.get('nope')).toThrow(/unknown app handle 'nope'/);
  });
});

describe('teardownAllAutomation', () => {
  it('is a safe no-op when no backend was ever constructed', async () => {
    // In the test (linux/node) environment with no Xvfb, getBackend hasn't
    // been forced; teardown must not throw.
    await expect(teardownAllAutomation()).resolves.toBeUndefined();
  });
});

describe('Linux backend preflight', () => {
  // On a real Linux box without the tools installed, preflight returns the
  // apt-install hint; on this (Windows dev / CI linux) host we just assert the
  // SHAPE of the result and that the hint text is correct when deps are
  // missing. We avoid mocking core node modules (that corrupts unrelated
  // imports like electron/tools); instead we drive the real preflight, which
  // on a machine lacking Xvfb/xdotool returns ok:false with the hint.
  it('returns a structured result; surfaces the apt-install hint when deps are missing', async () => {
    const { LinuxBackend } = await import('../electron/appAutomation.linux');
    const b = new LinuxBackend();
    const pf = await b.preflight();
    expect(typeof pf.ok).toBe('boolean');
    if (!pf.ok) {
      // The actionable hint must name the exact install command + a tool.
      expect(pf.reason).toMatch(/sudo apt install xvfb openbox xdotool scrot/);
      expect(pf.reason).toMatch(/Xvfb|xdotool/);
    }
  });
});

describe('App* tool schemas', () => {
  it('registers all seven App* tools with required fields', async () => {
    const { TOOLS } = await import('../electron/tools');
    for (const name of [
      'AppLaunch',
      'AppListWindows',
      'AppScreenshot',
      'AppClick',
      'AppDrag',
      'AppType',
      'AppPress',
      'AppClose',
    ]) {
      expect(TOOLS[name], `${name} should be registered`).toBeTruthy();
      expect(TOOLS[name].schema.name).toBe(name);
      expect(TOOLS[name].schema.input_schema).toBeTruthy();
    }
    // Spot-check a couple of required-arg contracts.
    expect((TOOLS['AppLaunch'].schema.input_schema as any).required).toContain('command');
    expect((TOOLS['AppClick'].schema.input_schema as any).required).toEqual(
      expect.arrayContaining(['appId', 'windowId', 'x', 'y'])
    );
    // AppDrag accepts a path of points (the freehand/draw primitive).
    const dragProps = (TOOLS['AppDrag'].schema.input_schema as any).properties;
    expect(dragProps.path).toBeTruthy();
    expect(dragProps.path.type).toBe('array');
  });

  it('AppDrag rejects a call with neither path nor from/to coords', async () => {
    const { TOOLS } = await import('../electron/tools');
    // On macOS the backend is null and we get the "not supported" message;
    // on win/linux with no path/coords we get the arg-validation message.
    // Either way it must NOT throw and must return an error string.
    const out = await TOOLS['AppDrag'].execute(
      { appId: 'x', windowId: 'y' },
      { sessionId: 's', cwd: '' } as any
    );
    expect(typeof out).toBe('string');
    expect(out as string).toMatch(/path|not supported|macOS/i);
  });
});
