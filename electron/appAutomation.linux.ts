// Linux app-automation backend.
//
// Each session is a private Xvfb virtual X server on its own DISPLAY (:N),
// with a lightweight WM (openbox) running on it. Apps launched with DISPLAY=:N
// render into Xvfb's offscreen framebuffer; xdotool drives input + enumerates
// windows on :N; scrot / ImageMagick `import` captures. Because everything is
// scoped to the :N connection, none of it can reach the user's real :0 display
// - input never moves their cursor, windows never appear on their screen.
//
// Dependencies (Xvfb, openbox, xdotool, scrot) are not bundleable; preflight()
// detects missing ones and returns an actionable apt-install hint.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import log from 'electron-log';
import {
  BaseBackend,
  newId,
  type AppHandle,
  type AppScreenshotResult,
  type AutomationBackend,
  type LaunchSpec,
  type WindowInfo,
} from './appAutomation';

const REQUIRED = ['Xvfb', 'openbox', 'xdotool', 'scrot'];

function which(bin: string): string | null {
  const r = spawnSync('which', [bin], { encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && existsSync(p) ? p : null;
}

interface LinuxSession {
  sessionId: string;
  display: string; // ":42"
  xvfb: ChildProcess;
  wm: ChildProcess;
  appPid: number;
  command: string;
}

/** Pick a free X display number by probing /tmp/.X11-unix/X<n>. */
function pickDisplay(): number {
  for (let n = 90; n < 200; n++) {
    if (!existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  }
  // Fall back to a random high number.
  return 200 + Math.floor(Math.random() * 300);
}

/** Run a command against a given DISPLAY, return stdout (throws on nonzero). */
function runOn(display: string, cmd: string, args: string[], timeoutMs = 10_000): string {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, DISPLAY: display },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed (${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
  return r.stdout ?? '';
}

export class LinuxBackend extends BaseBackend implements AutomationBackend {
  readonly platform = 'linux' as const;
  private readonly sessions = new Map<string, LinuxSession>();

  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    const missing = REQUIRED.filter((b) => !which(b));
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      reason:
        `app automation on Linux needs these tools, which are missing: ${missing.join(', ')}. ` +
        `Install them with:\n\n    sudo apt install xvfb openbox xdotool scrot\n\n` +
        `(or the dnf/pacman equivalent). They let Guy Code run apps on a private ` +
        `virtual display so your real screen, mouse, and keyboard are never disturbed.`,
    };
  }

  async launch(spec: LaunchSpec): Promise<AppHandle> {
    const pf = await this.preflight();
    if (!pf.ok) throw new Error(pf.reason);

    const n = pickDisplay();
    const display = `:${n}`;
    const w = spec.width ?? 1280;
    const h = spec.height ?? 800;

    // 1. Xvfb on the private display.
    const xvfb = spawn('Xvfb', [display, '-screen', '0', `${w}x${h}x24`, '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    // Wait for the X socket to appear.
    await this.waitForDisplay(display, 5000);

    // 2. Window manager on it.
    const wm = spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } });
    await new Promise((r) => setTimeout(r, 300));

    // 3. Launch the app.
    const argv = [spec.command, ...(spec.args ?? [])];
    const appProc = spawn(argv[0], argv.slice(1), {
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: display },
      detached: false,
    });
    if (!appProc.pid) {
      xvfb.kill();
      wm.kill();
      throw new Error(`failed to launch '${spec.command}' on ${display}`);
    }

    const appId = newId('app');
    const session: LinuxSession = {
      sessionId: newId('appsession'),
      display,
      xvfb,
      wm,
      appPid: appProc.pid,
      command: argv.join(' '),
    };
    this.sessions.set(appId, session);
    const handle: AppHandle = {
      appId,
      sessionId: session.sessionId,
      pid: appProc.pid,
      command: session.command,
    };
    this.register(handle);
    return handle;
  }

  private async waitForDisplay(display: string, timeoutMs: number): Promise<void> {
    const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(sock)) {
        // Confirm the server answers.
        const r = spawnSync('xdpyinfo', [], { env: { ...process.env, DISPLAY: display }, timeout: 2000 });
        if (r.status === 0) return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // xdpyinfo may be absent; accept the socket existing as good enough.
    if (existsSync(sock)) return;
    throw new Error(`Xvfb ${display} did not come up within ${timeoutMs}ms`);
  }

  private sessionFor(appId: string): LinuxSession {
    const s = this.sessions.get(appId);
    if (!s) throw new Error(`unknown app '${appId}' (closed?)`);
    return s;
  }

  async listWindows(appId: string): Promise<WindowInfo[]> {
    const s = this.sessionFor(appId);
    // xdotool search by pid -> window ids; geometry + name per window.
    let ids: string[] = [];
    try {
      ids = runOn(s.display, 'xdotool', ['search', '--onlyvisible', '--pid', String(s.appPid)])
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    } catch {
      // search returns nonzero when there are no matches.
      ids = [];
    }
    const out: WindowInfo[] = [];
    for (const id of ids) {
      try {
        const geo = runOn(s.display, 'xdotool', ['getwindowgeometry', '--shell', id]);
        const m: Record<string, string> = {};
        geo.split('\n').forEach((ln) => {
          const eq = ln.indexOf('=');
          if (eq > 0) m[ln.slice(0, eq).trim()] = ln.slice(eq + 1).trim();
        });
        const width = parseInt(m.WIDTH || '0', 10);
        const height = parseInt(m.HEIGHT || '0', 10);
        if (width < 20 || height < 20) continue; // skip tiny/util windows
        let title = '';
        try {
          title = runOn(s.display, 'xdotool', ['getwindowname', id]).trim();
        } catch {
          /* no name */
        }
        out.push({
          windowId: id,
          title,
          x: parseInt(m.X || '0', 10),
          y: parseInt(m.Y || '0', 10),
          width,
          height,
        });
      } catch {
        /* skip windows that vanished mid-enumerate */
      }
    }
    return out;
  }

  async screenshot(appId: string, windowId?: string): Promise<AppScreenshotResult> {
    const s = this.sessionFor(appId);
    let win = windowId;
    let geo = { x: 0, y: 0, width: 0, height: 0 };
    if (!win) {
      const ws = await this.listWindows(appId);
      if (ws.length === 0) throw new Error('no window to capture');
      win = ws[0].windowId;
      geo = ws[0];
    } else {
      const ws = await this.listWindows(appId);
      const found = ws.find((w) => w.windowId === win);
      if (found) geo = found;
    }
    // `import -window <id>` (ImageMagick) captures a specific window to PNG.
    const r = spawnSync('import', ['-window', win, 'png:-'], {
      env: { ...process.env, DISPLAY: s.display },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15_000,
    });
    if (r.status !== 0 || !r.stdout || r.stdout.length === 0) {
      // Fall back to scrot of the whole virtual screen.
      const r2 = spawnSync('scrot', ['-o', '/dev/stdout'], {
        env: { ...process.env, DISPLAY: s.display },
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15_000,
      });
      if (r2.status !== 0 || !r2.stdout) {
        throw new Error(`capture failed: ${(r.stderr || '').toString().trim().slice(0, 200)}`);
      }
      return { pngBase64: r2.stdout.toString('base64'), width: geo.width, height: geo.height };
    }
    return { pngBase64: r.stdout.toString('base64'), width: geo.width, height: geo.height };
  }

  async click(appId: string, windowId: string, x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    const s = this.sessionFor(appId);
    const btn = button === 'right' ? '3' : '1';
    // Move within the target window then click. --window keeps it scoped.
    runOn(s.display, 'xdotool', ['mousemove', '--window', windowId, String(x), String(y)]);
    runOn(s.display, 'xdotool', ['click', '--window', windowId, btn]);
  }

  async type(appId: string, windowId: string, text: string): Promise<void> {
    const s = this.sessionFor(appId);
    runOn(s.display, 'xdotool', ['type', '--window', windowId, '--', text]);
  }

  async key(appId: string, windowId: string, combo: string): Promise<void> {
    const s = this.sessionFor(appId);
    // xdotool uses the same chord syntax (ctrl+s, Return, etc.).
    runOn(s.display, 'xdotool', ['key', '--window', windowId, combo]);
  }

  async close(appId: string): Promise<void> {
    const s = this.sessions.get(appId);
    if (s) {
      this.killSession(s);
      this.sessions.delete(appId);
    }
    this.unregister(appId);
  }

  private killSession(s: LinuxSession) {
    try {
      process.kill(s.appPid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    try {
      s.wm.kill();
    } catch {
      /* ignore */
    }
    try {
      s.xvfb.kill();
    } catch {
      /* ignore */
    }
  }

  async teardownAll(): Promise<void> {
    for (const [, s] of this.sessions) {
      try {
        this.killSession(s);
      } catch (e) {
        log.error('[appAutomation.linux] teardown error', e);
      }
    }
    this.sessions.clear();
  }
}
