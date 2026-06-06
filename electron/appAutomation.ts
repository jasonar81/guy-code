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
  /** Type a string into the focused control of the window. */
  type(appId: string, windowId: string, text: string): Promise<void>;
  /** Press a key / chord (e.g. "Enter", "ctrl+s"). */
  key(appId: string, windowId: string, combo: string): Promise<void>;
  /** Close the app and tear down its isolated session. */
  close(appId: string): Promise<void>;
  /** Tear down everything (called on app quit). */
  teardownAll(): Promise<void>;
}

let _backend: AutomationBackend | null = null;
let _backendResolved = false;

/**
 * Get the platform backend, or null on an unsupported platform (macOS). Lazily
 * constructed so the (heavier) backend modules aren't imported until the first
 * App* tool is actually used.
 */
export async function getBackend(): Promise<AutomationBackend | null> {
  if (_backendResolved) return _backend;
  _backendResolved = true;
  if (process.platform === 'win32') {
    const { WindowsBackend } = await import('./appAutomation.win');
    _backend = new WindowsBackend();
  } else if (process.platform === 'linux') {
    const { LinuxBackend } = await import('./appAutomation.linux');
    _backend = new LinuxBackend();
  } else {
    _backend = null; // macOS unsupported
  }
  return _backend;
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
  if (!_backend) return;
  try {
    await _backend.teardownAll();
  } catch (e) {
    log.error('[appAutomation] teardownAll error', e);
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
