// Linux-VM app-automation backend for macOS.
//
// macOS has no native isolated automation path (single WindowServer; synthetic
// input is shared/disruptive), so a VM is the only way to drive apps without
// taking over the user's screen. We boot a lightweight Linux guest with QEMU
// (HVF-accelerated) and run the SAME Xvfb + xdotool + scrot stack as the
// Windows WSL path, talking to it over SSH.
//
// This mirrors LinuxVmBackend exactly, but the transport is sshExec (to the
// QEMU guest) instead of runInWsl. The command logic is identical because the
// guest is the same Linux automation environment.

import {
  BaseBackend,
  newId,
  type AppHandle,
  type AppScreenshotResult,
  type AutomationBackend,
  type LaunchSpec,
  type WindowInfo,
} from './appAutomation';
import { getMacVmStatus, bootGuest, sshExec, shutdownGuest } from './macVmProvision';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface MacVmSession {
  sessionId: string;
  display: string;
  pid: number;
  command: string;
}

function runOnDisplay(display: string, bash: string, timeoutMs = 15_000) {
  return sshExec(`export DISPLAY=${display}; ${bash}`, timeoutMs);
}

function captureBase64(display: string, target: string): string | null {
  const r = sshExec(
    `export DISPLAY=${display}; import -window ${target} png:- 2>/dev/null | base64 -w0`,
    20_000
  );
  if (r.code !== 0 || !r.out.trim()) {
    const r2 = sshExec(
      `export DISPLAY=${display}; scrot -o /tmp/_gc_cap.png 2>/dev/null && base64 -w0 /tmp/_gc_cap.png`,
      20_000
    );
    if (r2.code !== 0 || !r2.out.trim()) return null;
    return r2.out.trim();
  }
  return r.out.trim();
}

export class MacVmBackend extends BaseBackend implements AutomationBackend {
  readonly platform = 'linux' as const; // guest is linux
  private readonly sessions = new Map<string, MacVmSession>();

  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    const st = getMacVmStatus();
    if (!st.ready) return { ok: false, reason: st.reason };
    return { ok: true };
  }

  async launch(spec: LaunchSpec): Promise<AppHandle> {
    const pf = await this.preflight();
    if (!pf.ok) throw new Error(pf.reason);
    await bootGuest(); // idempotent; boots the guest if not running

    const n = await this.pickDisplay();
    const display = `:${n}`;
    const w = spec.width ?? 1280;
    const h = spec.height ?? 800;
    const appCmd = [spec.command, ...(spec.args ?? [])].join(' ');
    const logFile = `/tmp/_gc_app_${n}.log`;

    // Start Xvfb + openbox + app in the guest (backgrounded; the guest keeps
    // them alive). Same recipe as the WSL path.
    const startScript =
      `export DISPLAY=${display}; export SDL_AUDIODRIVER=dummy; export LIBGL_ALWAYS_SOFTWARE=1; ` +
      `pkill -f 'Xvfb ${display} ' 2>/dev/null; sleep 0.3; rm -f '/tmp/.X11-unix/X${n}' '${logFile}' 2>/dev/null; ` +
      `nohup Xvfb ${display} -screen 0 ${w}x${h}x24 -nolisten tcp >/dev/null 2>&1 & ` +
      `for i in $(seq 1 20); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.3; done; ` +
      `nohup openbox >/dev/null 2>&1 & sleep 0.5; ` +
      `nohup sh -c '( ${appCmd} ) >${logFile} 2>&1' >/dev/null 2>&1 &`;
    sshExec(startScript, 30_000);

    // Wait for a window.
    let gotWindow = false;
    for (let i = 0; i < 30; i++) {
      await delay(500);
      const wr = sshExec(`export DISPLAY=${display}; wmctrl -l 2>/dev/null | wc -l`, 5000);
      if (parseInt((wr.out || '0').trim(), 10) > 0) {
        gotWindow = true;
        break;
      }
    }
    if (!gotWindow) {
      const logr = sshExec(`tail -6 '${logFile}' 2>/dev/null`, 5000);
      throw new Error(
        `failed to launch '${appCmd}' in the Linux guest on ${display}. Log: ${(logr.out || '').trim().slice(0, 400)}`
      );
    }
    const pr = sshExec(
      `export DISPLAY=${display}; ` +
        `wid=$(wmctrl -l 2>/dev/null | head -1 | awk '{print $1}'); ` +
        `wmctrl -i -r "$wid" -b add,maximized_vert,maximized_horz 2>/dev/null; ` +
        `xdotool windowactivate --sync "$wid" 2>/dev/null; ` +
        `xdotool getwindowpid "$wid" 2>/dev/null`,
      6000
    );
    const pid = parseInt((pr.out || '0').trim(), 10) || 0;

    const appId = newId('app');
    const session: MacVmSession = { sessionId: newId('appsession'), display, pid, command: appCmd };
    this.sessions.set(appId, session);
    const handle: AppHandle = { appId, sessionId: session.sessionId, pid, command: appCmd };
    this.register(handle);
    return handle;
  }

  private async pickDisplay(): Promise<number> {
    const r = sshExec(
      `for n in $(seq 90 199); do [ -e /tmp/.X11-unix/X$n ] || { echo $n; break; }; done`,
      8000
    );
    const n = parseInt((r.out || '').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 90 + Math.floor(Math.random() * 100);
  }

  private sessionFor(appId: string): MacVmSession {
    const s = this.sessions.get(appId);
    if (!s) throw new Error(`unknown app '${appId}' (closed?)`);
    return s;
  }

  async listWindows(appId: string): Promise<WindowInfo[]> {
    const s = this.sessionFor(appId);
    let ids: string[] = [];
    const r = runOnDisplay(s.display, `xdotool search --onlyvisible --pid ${s.pid} 2>/dev/null`, 8000);
    ids = (r.out || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (ids.length === 0) {
      const r2 = runOnDisplay(s.display, `wmctrl -l 2>/dev/null | awk '{print $1}'`, 8000);
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

  async click(appId: string, windowId: string, x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    const s = this.sessionFor(appId);
    const btn = button === 'right' ? '3' : '1';
    runOnDisplay(s.display, `xdotool mousemove --window ${windowId} ${x} ${y} click --window ${windowId} ${btn}`, 8000);
  }

  async drag(appId: string, windowId: string, path: Array<{ x: number; y: number }>, button: 'left' | 'right' = 'left'): Promise<void> {
    const s = this.sessionFor(appId);
    if (path.length === 0) throw new Error('drag needs at least one point');
    const btn = button === 'right' ? '3' : '1';
    const pts: Array<{ x: number; y: number }> = [path[0]];
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const steps = Math.max(1, Math.min(60, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 6)));
      for (let i = 1; i <= steps; i++) {
        pts.push({ x: Math.round(a.x + ((b.x - a.x) * i) / steps), y: Math.round(a.y + ((b.y - a.y) * i) / steps) });
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
      `xdotool windowactivate --sync ${windowId} 2>/dev/null; xdotool type --window ${windowId} -- ${shellQuote(text)}`,
      10_000
    );
  }

  async key(appId: string, windowId: string, combo: string): Promise<void> {
    const s = this.sessionFor(appId);
    runOnDisplay(
      s.display,
      `xdotool windowactivate --sync ${windowId} 2>/dev/null; xdotool key --window ${windowId} ${shellQuote(combo)}`,
      8000
    );
  }

  async close(appId: string): Promise<void> {
    const s = this.sessions.get(appId);
    if (s) {
      sshExec(`kill ${s.pid} 2>/dev/null; pkill -f "Xvfb ${s.display} " 2>/dev/null; true`, 8000);
      this.sessions.delete(appId);
    }
    this.unregister(appId);
  }

  async teardownAll(): Promise<void> {
    for (const [, s] of this.sessions) {
      sshExec(`kill ${s.pid} 2>/dev/null; pkill -f "Xvfb ${s.display} " 2>/dev/null; true`, 6000);
    }
    this.sessions.clear();
    // Leave the guest running for reuse within the session; it's shut down on
    // app quit via teardown wiring + shutdownGuest.
    if (this.sessions.size === 0) shutdownGuest();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
