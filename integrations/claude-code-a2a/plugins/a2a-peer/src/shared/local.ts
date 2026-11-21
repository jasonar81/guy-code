/**
 * Talking to the daemon's local API from the hook and MCP processes
 * (design 7.2 "Local API" and "Lifecycle").
 *
 * The daemon listens on 127.0.0.1 on a random port and writes
 * `${CLAUDE_PLUGIN_DATA}/daemon.json` = { pid, port, token, a2aUrl } with
 * mode 0600. Every call carries `Authorization: Bearer <token>`, so another
 * local user (or a web page doing a blind POST to localhost) cannot read the
 * inbox or send as us.
 *
 * `ensureDaemon` is the lifecycle rule: if daemon.json is missing, the pid is
 * dead or the health check fails, spawn `node daemon.js` DETACHED and wait up
 * to 3 s for it to answer. The daemon outlives Claude Code on purpose, so
 * peers can still reach the user and watches keep running with no session
 * open.
 *
 * Plain node:http, no dependencies: the hook runs on every prompt and must
 * start fast and fail open.
 */
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  a2aUrl?: string;
  version?: string;
}

export const DAEMON_JSON = 'daemon.json';

export function readDaemonInfo(dataDir: string): DaemonInfo | null {
  try {
    const p = join(dataDir, DAEMON_JSON);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, 'utf8')) as DaemonInfo;
    return j && typeof j.port === 'number' && typeof j.token === 'string' ? j : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else. Treat as alive; the
    // health check (which needs our token) decides whether it is ours.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class LocalClient {
  constructor(readonly info: DaemonInfo) {}

  request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 2000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request(
        {
          host: '127.0.0.1',
          port: this.info.port,
          method,
          path,
          headers: {
            authorization: `Bearer ${this.info.token}`,
            ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            clearTimeout(timer);
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = text;
            }
            if ((res.statusCode ?? 500) >= 400) {
              const msg = parsed && typeof parsed === 'object' && 'error' in (parsed as object) ? String((parsed as { error: unknown }).error) : `HTTP ${res.statusCode}`;
              reject(new Error(msg));
            } else resolve(parsed as T);
          });
        }
      );
      const timer = setTimeout(() => req.destroy(new Error(`local API timed out after ${timeoutMs}ms`)), timeoutMs);
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      if (data) req.write(data);
      req.end();
    });
  }

  async health(timeoutMs = 1000): Promise<boolean> {
    try {
      const r = await this.request<{ ok?: boolean }>('GET', '/local/health', undefined, timeoutMs);
      return !!r?.ok;
    } catch {
      return false;
    }
  }

  /**
   * Subscribe to the server-sent events for one MCP connection. `onEvent` gets
   * each event's name and parsed data. Returns a closer; `onClose` fires when
   * the stream ends for any reason (the caller reconnects).
   */
  events(conn: string, onEvent: (name: string, data: unknown) => void, onClose: () => void): () => void {
    let closed = false;
    const req = http.request({
      host: '127.0.0.1',
      port: this.info.port,
      method: 'GET',
      path: `/local/events?conn=${encodeURIComponent(conn)}`,
      headers: { authorization: `Bearer ${this.info.token}`, accept: 'text/event-stream' },
    });
    const finish = () => {
      if (closed) return;
      closed = true;
      onClose();
    };
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish();
        return;
      }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let name = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue; // keep-alive comment
          try {
            onEvent(name, JSON.parse(data.join('\n')));
          } catch {
            /* malformed event: skip it */
          }
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('error', finish);
    req.end();
    return () => {
      closed = true;
      req.destroy();
    };
  }
}

/** A client for a daemon that is already up and healthy, else null. */
export async function connectDaemon(dataDir: string, timeoutMs = 1000): Promise<LocalClient | null> {
  const info = readDaemonInfo(dataDir);
  if (!info || !pidAlive(info.pid)) return null;
  const c = new LocalClient(info);
  return (await c.health(timeoutMs)) ? c : null;
}

/**
 * Connect, starting the daemon when it is not running (design 7.2 Lifecycle).
 * `daemonScript` is dist/daemon.js. Returns null when it did not come up in
 * `waitMs`; callers fail open.
 */
export async function ensureDaemon(opts: { dataDir: string; daemonScript: string; env?: NodeJS.ProcessEnv; waitMs?: number }): Promise<LocalClient | null> {
  const up = await connectDaemon(opts.dataDir);
  if (up) return up;
  if (!existsSync(opts.daemonScript)) return null;
  try {
    const child = spawn(process.execPath, [opts.daemonScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...(opts.env ?? process.env), CLAUDE_PLUGIN_DATA: opts.dataDir },
    });
    child.unref();
  } catch {
    return null;
  }
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const c = await connectDaemon(opts.dataDir, 500);
    if (c) return c;
  }
  return null;
}
