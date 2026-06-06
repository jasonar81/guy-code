// Windows app-automation backend.
//
// Each session is a long-lived C# helper process (GuyCodeAppHelper.exe). The
// helper creates a hidden Win32 desktop on startup and binds itself to it, so
// every app it launches + every UIA/capture/input op happens on that hidden
// desktop and NEVER on the user's interactive desktop. We talk to it over
// newline-delimited JSON on stdin/stdout.
//
// One helper == one session == one hidden desktop. We currently start a fresh
// session (helper) per launched app for clean isolation + teardown; the
// helper can host multiple apps on its desktop if we later want to group them.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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

/** Resolve the bundled helper exe path (dev tree + packaged app). */
function helperPath(): string {
  // Packaged: extraResources lands under process.resourcesPath/helper.
  const packaged = join(process.resourcesPath || '', 'helper', 'GuyCodeAppHelper.exe');
  if (existsSync(packaged)) return packaged;
  // Dev: build/helper/GuyCodeAppHelper.exe (produced by scripts/build-helper).
  const dev = join(__dirname, '..', 'build', 'helper', 'GuyCodeAppHelper.exe');
  return dev;
}

interface Pending {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
}

/** One helper process + its line-protocol plumbing. */
class HelperSession {
  readonly sessionId: string;
  private proc: ChildProcessWithoutNullStreams;
  private seq = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = '';
  private readyPromise: Promise<void>;
  private deadReason: string | null = null;

  constructor(exe: string) {
    this.sessionId = newId('appsession');
    this.proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d: string) => log.warn(`[appAutomation.win] helper stderr: ${d.trim()}`));
    this.proc.on('exit', (code) => {
      this.deadReason = `helper exited (code ${code})`;
      for (const [, p] of this.pending) p.reject(new Error(this.deadReason));
      this.pending.clear();
    });
    // The helper emits a {ready:true} line (id 0) once the desktop is up.
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.pending.set(0, {
        resolve: () => resolve(),
        reject: (e) => reject(e),
      });
      setTimeout(() => {
        if (this.pending.has(0)) {
          this.pending.delete(0);
          reject(new Error('helper did not signal ready within 10s'));
        }
      }, 10_000);
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn(`[appAutomation.win] non-JSON helper line: ${line.slice(0, 120)}`);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.data ?? {});
      else p.reject(new Error(msg.error || 'helper error'));
    }
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Send an op and await its response. */
  rpc(op: string, args: Record<string, unknown> = {}): Promise<any> {
    if (this.deadReason) return Promise.reject(new Error(this.deadReason));
    const id = ++this.seq;
    const payload = JSON.stringify({ id, op, ...args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.proc.stdin.write(payload + '\n');
      } catch (e: any) {
        this.pending.delete(id);
        reject(new Error(`helper write failed: ${e?.message ?? e}`));
        return;
      }
      // Per-op timeout so a wedged helper can't hang a tool forever.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`helper op '${op}' timed out`));
        }
      }, 30_000);
    });
  }

  kill() {
    try {
      this.proc.stdin.write(JSON.stringify({ id: ++this.seq, op: 'shutdown' }) + '\n');
    } catch {
      /* ignore */
    }
    // Give it a moment to tear down its desktop, then hard-kill.
    setTimeout(() => {
      if (!this.proc.killed) {
        try {
          this.proc.kill();
        } catch {
          /* ignore */
        }
      }
    }, 1500);
  }
}

export class WindowsBackend extends BaseBackend implements AutomationBackend {
  readonly platform = 'win32' as const;
  /** appId -> the helper session hosting it. */
  private readonly sessions = new Map<string, HelperSession>();

  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    const exe = helperPath();
    if (!existsSync(exe)) {
      return {
        ok: false,
        reason:
          `app-automation helper not found at ${exe}. It ships with Guy Code; ` +
          `if this is a dev build, run "npm run build-helper".`,
      };
    }
    return { ok: true };
  }

  async launch(spec: LaunchSpec): Promise<AppHandle> {
    const pf = await this.preflight();
    if (!pf.ok) throw new Error(pf.reason);
    const session = new HelperSession(helperPath());
    await session.ready();
    const command = [spec.command, ...(spec.args ?? [])].join(' ');
    const data = await session.rpc('launch', { command });
    const handle: AppHandle = {
      appId: data.appId, // helper-local "appN"; unique per session, fine since 1 app/session
      sessionId: session.sessionId,
      pid: data.pid,
      command,
    };
    // Re-key the handle under a globally-unique appId we hand back to tools,
    // but remember the helper-local id for rpc calls.
    const globalId = newId('app');
    (handle as any).helperAppId = handle.appId;
    handle.appId = globalId;
    this.register(handle);
    this.sessions.set(globalId, session);
    return handle;
  }

  private helperFor(appId: string): { session: HelperSession; helperAppId: string } {
    const handle = this.getHandle(appId);
    const session = this.sessions.get(appId);
    if (!session) throw new Error(`no helper session for app '${appId}'`);
    return { session, helperAppId: (handle as any).helperAppId };
  }

  async listWindows(appId: string): Promise<WindowInfo[]> {
    const { session, helperAppId } = this.helperFor(appId);
    const data = await session.rpc('list', { appId: helperAppId });
    return (data.windows ?? []) as WindowInfo[];
  }

  async screenshot(appId: string, windowId?: string): Promise<AppScreenshotResult> {
    const { session, helperAppId } = this.helperFor(appId);
    const data = await session.rpc('screenshot', { appId: helperAppId, windowId: windowId ?? '' });
    return { pngBase64: data.pngBase64, width: data.width, height: data.height };
  }

  async click(appId: string, windowId: string, x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    const { session, helperAppId } = this.helperFor(appId);
    await session.rpc('click', { appId: helperAppId, windowId, x, y, button });
  }

  async type(appId: string, windowId: string, text: string): Promise<void> {
    const { session, helperAppId } = this.helperFor(appId);
    await session.rpc('type', { appId: helperAppId, windowId, text });
  }

  async key(appId: string, windowId: string, combo: string): Promise<void> {
    const { session, helperAppId } = this.helperFor(appId);
    await session.rpc('key', { appId: helperAppId, windowId, combo });
  }

  async close(appId: string): Promise<void> {
    const session = this.sessions.get(appId);
    if (session) {
      try {
        const { helperAppId } = this.helperFor(appId);
        await session.rpc('close', { appId: helperAppId }).catch(() => {});
      } catch {
        /* ignore */
      }
      session.kill();
      this.sessions.delete(appId);
    }
    this.unregister(appId);
  }

  async teardownAll(): Promise<void> {
    for (const [, session] of this.sessions) session.kill();
    this.sessions.clear();
  }
}
