// Linux-VM app-automation backend (Windows, via WSL2).
//
// Runs the Linux automation stack INSIDE WSL: a private Xvfb display + openbox
// + the target Linux app, driven with xdotool (real X input) and captured with
// ImageMagick `import`. Because WSL2 is a real Linux VM with a real X server,
// device-state input (games/emulators via SDL/X11, drawing apps) works - which
// the native Windows hidden-desktop backend cannot do. Fully isolated from the
// user's Windows desktop.
//
// One session == one Xvfb display + its app, all living inside WSL. We keep a
// long-lived `wsl.exe` process running a shell loop that holds the Xvfb/openbox/
// app alive, and issue per-op xdotool/import commands via short WSL calls.

import { spawn, type ChildProcess } from 'node:child_process';
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
import {
  runInWsl,
  getWslStatus,
  shellQuote,
  displaySocketReady,
} from './wslProvision';

interface VmSession {
  sessionId: string;
  display: string; // ":97"
  pid: number; // app pid inside WSL
  keeper: ChildProcess; // the wsl.exe process holding the session alive
  command: string;
}

/** Run an xdotool/import/etc command on a given DISPLAY inside WSL. */
function runOnDisplay(
  display: string,
  bash: string,
  timeoutMs = 15_000
): { code: number; out: string; err: string } {
  return runInWsl(`export DISPLAY=${display}; ${bash}`, timeoutMs);
}

/** Capture a window (or root) as base64 PNG, via import in WSL. */
function captureBase64(display: string, target: string): string | null {
  // import writes PNG to stdout; we base64 it INSIDE wsl so the bytes survive
  // the transport cleanly, then decode host-side.
  const r = runInWsl(
    `export DISPLAY=${display}; import -window ${target} png:- 2>/dev/null | base64 -w0`,
    20_000
  );
  if (r.code !== 0 || !r.out.trim()) {
    // Fallback: scrot the whole virtual screen.
    const r2 = runInWsl(
      `export DISPLAY=${display}; scrot -o /tmp/_gc_cap.png 2>/dev/null && base64 -w0 /tmp/_gc_cap.png`,
      20_000
    );
    if (r2.code !== 0 || !r2.out.trim()) return null;
    return r2.out.trim();
  }
  return r.out.trim();
}

export class LinuxVmBackend extends BaseBackend implements AutomationBackend {
  readonly platform = 'win32' as const; // host platform; guest is linux
  private readonly sessions = new Map<string, VmSession>();

  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    const st = getWslStatus();
    if (!st.installed) return { ok: false, reason: st.reason };
    if (!st.depsInstalled) return { ok: false, reason: st.reason };
    if (!displaySocketReady()) {
      return {
        ok: false,
        reason:
          'The WSL X11 socket directory isn\'t configured for headless display. Re-run setup in Settings > Linux app automation (it sets a one-time WSL boot hook), or restart WSL.',
      };
    }
    return { ok: true };
  }

  async launch(spec: LaunchSpec): Promise<AppHandle> {
    const pf = await this.preflight();
    if (!pf.ok) throw new Error(pf.reason);

    const n = await this.pickDisplay();
    const display = `:${n}`;
    const w = spec.width ?? 1280;
    const h = spec.height ?? 800;
    const appCmd = [spec.command, ...(spec.args ?? [])].join(' ');

    // The keeper is ONE long-lived wsl.exe process whose shell starts Xvfb +
    // openbox + the app, then blocks on Xvfb so the whole session lives as
    // long as the keeper. Success == a window appears (robust across apps that
    // fork/re-exec, like emulators) - we don't depend on capturing the app
    // pid. SDL_AUDIODRIVER=dummy + no sound so audio-less WSL doesn't kill
    // emulators. Clean any stale Xvfb/socket on this display first.
    const logFile = `/tmp/_gc_app_${n}.log`;
    // Keeper: start Xvfb, WAIT for it to actually serve (poll xdpyinfo, not a
    // fixed sleep - Xvfb can take a couple seconds), start openbox, then the
    // app. Block on Xvfb so the session lives with the keeper. Clean stale
    // Xvfb/socket on this display first.
    // NOTE: do NOT `pkill -f 'Xvfb :N '` here - the keeper's own command line
    // contains that string, so pkill would kill the keeper itself (exit 15).
    // We just remove a stale socket and let Xvfb claim the display.
    const keeperScript =
      `export DISPLAY=${display}; export SDL_AUDIODRIVER=dummy; export LIBGL_ALWAYS_SOFTWARE=1; ` +
      // Ensure the X11 socket dir exists + is writable. WSLg sometimes leaves
      // it missing or read-only; the wsl.conf boot hook fixes perms at boot,
      // but create it here too so a transient state can't break the launch.
      `if [ ! -d /tmp/.X11-unix ]; then mkdir -p /tmp/.X11-unix 2>/dev/null; chmod 1777 /tmp/.X11-unix 2>/dev/null; fi; ` +
      `rm -f '/tmp/.X11-unix/X${n}' '${logFile}' 2>/dev/null; ` +
      `Xvfb ${display} -screen 0 ${w}x${h}x24 -nolisten tcp >/dev/null 2>&1 & XVFB=$!; ` +
      `for i in $(seq 1 20); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.3; done; ` +
      `openbox >/dev/null 2>&1 & sleep 0.5; ` +
      `( ${appCmd} ) >'${logFile}' 2>&1 & ` +
      `wait $XVFB`;

    // NON-login shell (-c): WSLg's login profile resets DISPLAY to :0, which
    // would break our Xvfb display.
    const keeper = spawn('wsl.exe', ['-e', 'bash', '-c', keeperScript], {
      windowsHide: true,
      stdio: 'ignore',
    });

    // Wait for a window to appear on the display (the success signal).
    let gotWindow = false;
    for (let i = 0; i < 30; i++) {
      await delay(500);
      const wr = runInWsl(
        `export DISPLAY=${display}; wmctrl -l 2>/dev/null | wc -l`,
        5000
      );
      if (parseInt((wr.out || '0').trim(), 10) > 0) {
        gotWindow = true;
        break;
      }
      if (keeper.exitCode !== null) break; // keeper died (Xvfb failed)
    }
    if (!gotWindow) {
      try {
        keeper.kill();
      } catch {
        /* ignore */
      }
      const logr = runInWsl(`tail -6 '${logFile}' 2>/dev/null`, 5000);
      throw new Error(
        `failed to launch '${appCmd}' in WSL on ${display} (no window appeared). Log: ${(logr.out || '').trim().slice(0, 400)}`
      );
    }
    // Activate + maximize the app window so it fills the virtual display - this
    // gives a large, predictable canvas/content area and ensures the window has
    // input focus (some apps only accept keyboard input when focused). Then
    // resolve the app pid from its window (used by close()).
    const pr = runInWsl(
      `export DISPLAY=${display}; ` +
        `wid=$(wmctrl -l 2>/dev/null | head -1 | awk '{print $1}'); ` +
        `wmctrl -i -r "$wid" -b add,maximized_vert,maximized_horz 2>/dev/null; ` +
        `xdotool windowactivate --sync "$wid" 2>/dev/null; ` +
        `xdotool getwindowpid "$wid" 2>/dev/null`,
      6000
    );
    const pid = parseInt((pr.out || '0').trim(), 10) || 0;

    const appId = newId('app');
    const session: VmSession = {
      sessionId: newId('appsession'),
      display,
      pid,
      keeper,
      command: appCmd,
    };
    this.sessions.set(appId, session);
    const handle: AppHandle = { appId, sessionId: session.sessionId, pid, command: appCmd };
    this.register(handle);
    return handle;
  }

  private async pickDisplay(): Promise<number> {
    // Find a display whose socket is free AND has no live Xvfb. Kill any stale
    // Xvfb whose socket lingers without a process (from a crashed prior run),
    // then pick the first free number. Done in a separate command (not the
    // keeper) so we never pkill the keeper's own command line.
    const r = runInWsl(
      `for n in $(seq 90 199); do ` +
        `if [ -e /tmp/.X11-unix/X$n ]; then ` +
        `pgrep -f "Xvfb :$n " >/dev/null 2>&1 || rm -f /tmp/.X11-unix/X$n 2>/dev/null; ` +
        `fi; ` +
        `if [ ! -e /tmp/.X11-unix/X$n ]; then echo $n; break; fi; ` +
        `done`,
      10_000
    );
    const n = parseInt((r.out || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 90 + Math.floor(Math.random() * 100);
  }

  private sessionFor(appId: string): VmSession {
    const s = this.sessions.get(appId);
    if (!s) throw new Error(`unknown app '${appId}' (closed?)`);
    return s;
  }

  async listWindows(appId: string): Promise<WindowInfo[]> {
    const s = this.sessionFor(appId);
    // Find visible windows for our app pid; fall back to all wmctrl windows.
    let ids: string[] = [];
    const r = runOnDisplay(
      s.display,
      `xdotool search --onlyvisible --pid ${s.pid} 2>/dev/null`,
      8000
    );
    ids = (r.out || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (ids.length === 0) {
      // Some apps (emulators) reparent; grab any sizeable visible window.
      const r2 = runOnDisplay(
        s.display,
        `wmctrl -l 2>/dev/null | awk '{print $1}'`,
        8000
      );
      ids = (r2.out || '').split('\n').map((x) => x.trim()).filter(Boolean);
    }
    const out: WindowInfo[] = [];
    for (const id of ids) {
      const geo = runOnDisplay(
        s.display,
        `xdotool getwindowgeometry --shell ${id} 2>/dev/null; echo "NAME=$(xdotool getwindowname ${id} 2>/dev/null)"`,
        6000
      );
      if (geo.code !== 0) continue;
      const m: Record<string, string> = {};
      (geo.out || '').split('\n').forEach((ln) => {
        const eq = ln.indexOf('=');
        if (eq > 0) m[ln.slice(0, eq).trim()] = ln.slice(eq + 1).trim();
      });
      const width = parseInt(m.WIDTH || '0', 10);
      const height = parseInt(m.HEIGHT || '0', 10);
      if (width < 20 || height < 20) continue;
      out.push({
        windowId: id,
        title: m.NAME || '',
        x: parseInt(m.X || '0', 10),
        y: parseInt(m.Y || '0', 10),
        width,
        height,
      });
    }
    return out;
  }

  async screenshot(appId: string, windowId?: string): Promise<AppScreenshotResult> {
    const s = this.sessionFor(appId);
    let target = windowId || '';
    let geo = { width: 0, height: 0 };
    const wins = await this.listWindows(appId);
    if (!target) {
      if (wins.length === 0) {
        // No window yet; capture the whole virtual root.
        const b64root = captureBase64(s.display, 'root');
        if (!b64root) throw new Error('no window and root capture failed');
        return { pngBase64: b64root, width: 0, height: 0 };
      }
      target = wins[0].windowId;
      geo = wins[0];
    } else {
      const found = wins.find((wnd) => wnd.windowId === target);
      if (found) geo = found;
    }
    const b64 = captureBase64(s.display, target);
    if (!b64) throw new Error('capture failed');
    return { pngBase64: b64, width: geo.width, height: geo.height };
  }

  async click(
    appId: string,
    windowId: string,
    x: number,
    y: number,
    button: 'left' | 'right' = 'left'
  ): Promise<void> {
    const s = this.sessionFor(appId);
    const btn = button === 'right' ? '3' : '1';
    runOnDisplay(
      s.display,
      `xdotool mousemove --window ${windowId} ${x} ${y} click --window ${windowId} ${btn}`,
      8000
    );
  }

  async drag(
    appId: string,
    windowId: string,
    path: Array<{ x: number; y: number }>,
    button: 'left' | 'right' = 'left'
  ): Promise<void> {
    const s = this.sessionFor(appId);
    if (path.length === 0) throw new Error('drag needs at least one point');
    const btn = button === 'right' ? '3' : '1';
    // Interpolate for a smooth stroke.
    const pts: Array<{ x: number; y: number }> = [path[0]];
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const steps = Math.max(1, Math.min(60, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 6)));
      for (let i = 1; i <= steps; i++) {
        pts.push({
          x: Math.round(a.x + ((b.x - a.x) * i) / steps),
          y: Math.round(a.y + ((b.y - a.y) * i) / steps),
        });
      }
    }
    const moves = pts
      .map((p, i) =>
        i === 0
          ? `mousemove --window ${windowId} ${p.x} ${p.y} mousedown --window ${windowId} ${btn}`
          : `mousemove --window ${windowId} ${p.x} ${p.y}`
      )
      .join(' ');
    runOnDisplay(s.display, `xdotool ${moves} mouseup --window ${windowId} ${btn}`, 20_000);
  }

  async type(appId: string, windowId: string, text: string): Promise<void> {
    const s = this.sessionFor(appId);
    runOnDisplay(
      s.display,
      `xdotool windowactivate --sync ${windowId} 2>/dev/null; ` +
        `xdotool type --window ${windowId} -- ${shellQuote(text)}`,
      10_000
    );
  }

  async key(appId: string, windowId: string, combo: string): Promise<void> {
    const s = this.sessionFor(appId);
    // xdotool uses the same chord syntax (ctrl+s, Return, F, etc.). Activate
    // the window first so games/apps that need focus receive the key.
    runOnDisplay(
      s.display,
      `xdotool windowactivate --sync ${windowId} 2>/dev/null; ` +
        `xdotool key --window ${windowId} ${shellQuote(combo)}`,
      8000
    );
  }

  async close(appId: string): Promise<void> {
    const s = this.sessions.get(appId);
    if (s) {
      // Kill the app + Xvfb inside WSL, then the keeper process.
      runInWsl(
        `kill ${s.pid} 2>/dev/null; pkill -f "Xvfb ${s.display} " 2>/dev/null; true`,
        8000
      );
      try {
        s.keeper.kill();
      } catch {
        /* ignore */
      }
      this.sessions.delete(appId);
    }
    this.unregister(appId);
  }

  async teardownAll(): Promise<void> {
    for (const [, s] of this.sessions) {
      try {
        runInWsl(`kill ${s.pid} 2>/dev/null; pkill -f "Xvfb ${s.display} " 2>/dev/null; true`, 6000);
        s.keeper.kill();
      } catch (e) {
        log.error('[appAutomation.linuxvm] teardown error', e);
      }
    }
    this.sessions.clear();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
