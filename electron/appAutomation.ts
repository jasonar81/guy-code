// App automation: launch, drive, and close arbitrary GUI applications in an
// ISOLATED display/desktop, so the user's real screen / mouse / keyboard are
// never disturbed. Windows + Linux only (not macOS).
//
// Architecture
//   - A platform-specific AutomationBackend does the real work:
//       * Windows: a bundled C# helper exe, launched ONTO a hidden Win32
//         desktop (CreateDesktop), driven over JSON-over-stdio. The helper
//         owns launch / UI-Automation / PrintWindow capture / input / close
//         for that desktop. Because the helper's own threads live on the
//         hidden desktop, UIA + capture + input "just work" against it
//         without SetThreadDesktop juggling, and nothing renders on the
//         user's interactive desktop.
//       * Linux: spawn an Xvfb virtual X server on a private DISPLAY (:N),
//         start a lightweight WM (openbox) on it, launch apps with
//         DISPLAY=:N, and drive them with xdotool (input/enumerate) + scrot
//         / ImageMagick import (capture). Input to :N can't reach the user's
//         real :0, so it's fully isolated.
//   - One "session" == one isolated desktop/display that can host one or
//     more launched apps. Sessions are tracked here and torn down on app
//     quit so we never leak an Xvfb process or a hidden desktop.
//
// The tools layer (AppLaunch / AppListWindows / AppScreenshot / AppClick /
// AppType / AppPress / AppClose) is a thin wrapper over this module, mirroring
// the Browser* tools.

import { randomUUID } from 'node:crypto';
import log from 'electron-log';

/** A launched application the agent can drive. */
export interface AppHandle {
  /** Stable id the tools pass back in for subsequent calls. */
  appId: string;
  /** The isolation session (hidden desktop / Xvfb display) hosting it. */
  sessionId: string;
  /** OS pid of the launched process (best-effort; some apps re-spawn). */
  pid: number;
  /** The command that was launched. */
  command: string;
}

/** A top-level window belonging to a launched app. */
export interface WindowInfo {
  /** Backend-stable window id (Win32 HWND as string, or X11 window id). */
  windowId: string;
  title: string;
  /** Window rect in the isolated display's coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaunchSpec {
  /** Executable or command to launch (e.g. "notepad.exe", "/usr/bin/gedit"). */
  command: string;
  /** Optional arguments. */
  args?: string[];
  /** Virtual display size for the isolated session. */
  width?: number;
  height?: number;
}

/** What a screenshot returns: PNG bytes + the window geometry it covers. */
export interface AppScreenshotResult {
  pngBase64: string;
  width: number;
  height: number;
}

/**
 * Platform backend contract. All methods reject with a descriptive Error on
 * failure; the tools layer surfaces the message to the model.
 */
export interface AutomationBackend {
  readonly platform: 'win32' | 'linux';
  /** Is the backend usable on this machine? Returns a reason when not. */
  preflight(): Promise<{ ok: boolean; reason?: string }>;
  /** Launch an app in a fresh isolated session. */
  launch(spec: LaunchSpec): Promise<AppHandle>;
  /** Enumerate the app's top-level windows. */
  listWindows(appId: string): Promise<WindowInfo[]>;
  /** Capture a window (or the app's primary window if windowId omitted). */
  screenshot(appId: string, windowId?: string): Promise<AppScreenshotResult>;
  /** Click at window-relative coordinates. */
  click(appId: string, windowId: string, x: number, y: number, button?: 'left' | 'right'): Promise<void>;
  /**
   * Press-move-release drag through a path of window-relative points. The
   * backend interpolates between points for a smooth motion, so a 2-point
   * path is a straight drag (shape-tool bounds, slider, drag-and-drop) and a
   * many-point path is a freehand stroke. Uses REAL mouse input on the
   * isolated display, so it actually draws / drags (unlike a UIA invoke).
   */
  drag(appId: string, windowId: string, path: Array<{ x: number; y: number }>, button?: 'left' | 'right'): Promise<void>;
  /** Type a string into the focused control of the window. */
  type(appId: string, windowId: string, text: string): Promise<void>;
  /** Press a key / chord (e.g. "Enter", "ctrl+s"). */
  key(appId: string, windowId: string, combo: string): Promise<void>;
  /** Close the app and tear down its isolated session. */
  close(appId: string): Promise<void>;
  /** Tear down everything (called on app quit). */
  teardownAll(): Promise<void>;
}

/** Which automation path to use. */
export type AutomationMode = 'native' | 'linux-vm';

// Backends are cached per mode so the native and linux-vm paths can coexist
// (a user may drive a normal Win32 app natively AND an emulator in the VM).
const _backends = new Map<AutomationMode, AutomationBackend | null>();

/**
 * Resolve the default mode for the host platform when the caller doesn't
 * specify one. Windows/Linux default to native; macOS has no native backend,
 * so it defaults to linux-vm (a Linux guest) which is its only path.
 */
export function defaultMode(): AutomationMode {
  return process.platform === 'darwin' ? 'linux-vm' : 'native';
}

/**
 * Get the automation backend for a given mode, or null if unavailable on this
 * platform. Lazily constructed so the (heavier) backend modules aren't
 * imported until first use.
 *
 *   native   : Windows hidden-desktop (PostMessage) / Linux Xvfb. Best for
 *              normal GUI apps. On Windows: classic Win32 only (not modern
 *              Store/WinUI3, not games). Unavailable on macOS.
 *   linux-vm : a Linux guest (WSL2 on Windows, QEMU/Virtualization.framework
 *              on macOS) running Xvfb + xdotool. Drives Linux apps incl
 *              games/emulators (device-state input) + drawing. The only path
 *              on macOS.
 */
export async function getBackend(
  mode: AutomationMode = defaultMode()
): Promise<AutomationBackend | null> {
  if (_backends.has(mode)) return _backends.get(mode) ?? null;
  let backend: AutomationBackend | null = null;
  if (mode === 'native') {
    if (process.platform === 'win32') {
      const { WindowsBackend } = await import('./appAutomation.win');
      backend = new WindowsBackend();
    } else if (process.platform === 'linux') {
      const { LinuxBackend } = await import('./appAutomation.linux');
      backend = new LinuxBackend();
    } else {
      backend = null; // macOS has no native backend
    }
  } else {
    // linux-vm
    if (process.platform === 'win32') {
      const { LinuxVmBackend } = await import('./appAutomation.linuxvm');
      backend = new LinuxVmBackend();
    } else if (process.platform === 'darwin') {
      const { MacVmBackend } = await import('./appAutomation.macvm');
      backend = new MacVmBackend();
    } else if (process.platform === 'linux') {
      // On Linux the native backend already IS a Linux/Xvfb backend.
      const { LinuxBackend } = await import('./appAutomation.linux');
      backend = new LinuxBackend();
    }
  }
  _backends.set(mode, backend);
  return backend;
}

/** Generate a fresh app/session id. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/**
 * Tear down all automation sessions. Wired to app 'before-quit' so a crash or
 * normal exit never leaves an orphaned Xvfb process or hidden desktop. Safe to
 * call when no backend was ever constructed.
 */
export async function teardownAllAutomation(): Promise<void> {
  for (const backend of _backends.values()) {
    if (!backend) continue;
    try {
      await backend.teardownAll();
    } catch (e) {
      log.error('[appAutomation] teardownAll error', e);
    }
  }
}

/**
 * Shared base for backends: tracks app handles + their sessions, generates
 * ids, and provides a registry the concrete backends fill in. Concrete
 * backends store their own per-session state (helper process / Xvfb pid) in
 * their own maps keyed by sessionId.
 */
export abstract class BaseBackend {
  protected readonly handles = new Map<string, AppHandle>();

  protected getHandle(appId: string): AppHandle {
    const h = this.handles.get(appId);
    if (!h) throw new Error(`unknown app handle '${appId}' (it may have been closed)`);
    return h;
  }

  protected register(h: AppHandle): void {
    this.handles.set(h.appId, h);
  }

  protected unregister(appId: string): void {
    this.handles.delete(appId);
  }
}
