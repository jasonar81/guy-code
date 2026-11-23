/**
 * The daemon's local API (design 7.2): 127.0.0.1 only, random port, bearer
 * token from daemon.json. It backs the MCP tools, the hooks and the CLI.
 *
 *   GET  /local/health                    liveness (needs the token too)
 *   POST /local/register {cwd, cc_pid, session_id?} -> {conn, session_id}
 *   GET  /local/events?conn=...            SSE stream of channel items
 *   GET  /local/inbox?session_id=          unacked items for a session
 *   POST /local/ack {ids}
 *   POST /local/hook/<Event> <hook stdin>  SessionStart, UserPromptSubmit, Stop, SessionEnd
 *   POST /local/tool/<name> {args, conn?}  a2a_* tools
 *   POST /local/pair|trust|label|status    CLI only (slash commands)
 *
 * Every route checks the token with timingSafeEqual, and requests with an
 * Origin header are refused, so a web page in the user's browser cannot
 * drive the API even if it guesses the port. Bodies are capped.
 */
import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { DaemonCore } from './core';
import type { RelayStatus } from './shared/protocol';

/** One status line for the relay (design 11a). */
export function relayLine(s: RelayStatus | null): string {
  if (!s) return 'Relay: off';
  return `Relay: ${s.state} (${s.url})${s.lastError && s.state !== 'connected' ? ` - last error: ${s.lastError}` : ''}`;
}
import {
  hookSessionEnd,
  hookSessionStart,
  hookStop,
  hookUserPrompt,
  opCancel,
  opInbox,
  opInvite,
  opPeers,
  opRedeem,
  opReply,
  opRequest,
  opRevoke,
  opSend,
  opTasks,
  opTrust,
  opWait,
  opWatch,
  type OpCtx,
} from './ops';

const MAX_BODY = 512 * 1024;

export const TOOL_NAMES = ['a2a_peers', 'a2a_send', 'a2a_request', 'a2a_reply', 'a2a_watch', 'a2a_tasks', 'a2a_inbox', 'a2a_cancel', 'a2a_wait'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface LocalApi {
  port: number;
  close(): Promise<void>;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const t = Buffer.concat(chunks).toString('utf8');
        resolve(t ? JSON.parse(t) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(data.length), 'cache-control': 'no-store' });
  res.end(data);
}

/** Run one a2a_* tool. Exported for the tests, which skip HTTP. */
export async function runTool(core: DaemonCore, name: string, args: Record<string, any>, ctx: OpCtx, signal?: AbortSignal): Promise<string> {
  switch (name as ToolName) {
    case 'a2a_peers':
      return opPeers(core);
    case 'a2a_send':
      return opSend(core, args as any, ctx);
    case 'a2a_request':
      return opRequest(core, args as any, ctx);
    case 'a2a_reply':
      return opReply(core, args as any, ctx);
    case 'a2a_watch':
      return opWatch(core, args as any, ctx);
    case 'a2a_tasks':
      return opTasks(core, args as any);
    case 'a2a_inbox':
      return opInbox(core, args as any, ctx);
    case 'a2a_cancel':
      return opCancel(core, args as any);
    case 'a2a_wait':
      return opWait(core, args as any, ctx, signal);
    default:
      return `error: unknown tool ${name}`;
  }
}

export function startLocalApi(core: DaemonCore, token: string, opts: { port?: number; onActivity?: () => void } = {}): Promise<LocalApi> {
  // Which session each MCP connection belongs to (set by /local/register).
  const conns = new Map<string, { sessionId: string | null; cwd: string | null; ccPid: number | null }>();
  const ctxFor = (conn: unknown, fallback: { session_id?: unknown; cwd?: unknown }): OpCtx => {
    const c = typeof conn === 'string' ? conns.get(conn) : undefined;
    let sessionId = c?.sessionId ?? (typeof fallback.session_id === 'string' ? fallback.session_id : null);
    if (c && !sessionId) {
      // Registered before SessionStart reached us: try again now.
      sessionId = core.cc.correlate({ ccPid: c.ccPid, cwd: c.cwd })?.session_id ?? null;
      if (sessionId) {
        c.sessionId = sessionId;
        core.bindConnection(String(conn), sessionId);
      }
    }
    const s = sessionId ? core.cc.getSession(sessionId) : undefined;
    return { sessionId, cwd: s?.cwd ?? c?.cwd ?? (typeof fallback.cwd === 'string' ? fallback.cwd : null) };
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.origin) return send(res, 403, { error: 'browser requests are not accepted' });
      if (!tokenOk(req.headers.authorization, token)) return send(res, 401, { error: 'unauthorised' });
      opts.onActivity?.();
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const p = url.pathname;

      if (req.method === 'GET' && p === '/local/health') return send(res, 200, { ok: true, a2aUrl: core.node.isRunning() ? core.node.origin() : null });

      if (req.method === 'GET' && p === '/local/events') {
        const conn = url.searchParams.get('conn') ?? '';
        const c = conns.get(conn);
        if (!c) return send(res, 404, { error: 'unknown connection; register first' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        const write = (event: string, data: unknown) => {
          if (res.destroyed) return false;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return true;
        };
        core.subscribe(conn, { sessionId: c.sessionId, ccPid: c.ccPid, cwd: c.cwd, send: write });
        core.replayTo(conn);
        const ka = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        ka.unref?.();
        req.on('close', () => {
          clearInterval(ka);
          core.unsubscribe(conn);
        });
        return;
      }

      if (req.method === 'GET' && p === '/local/inbox') {
        const sid = url.searchParams.get('session_id');
        return send(res, 200, { items: sid ? core.cc.unacked(sid) : core.cc.allUnacked() });
      }

      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      const body = (await readBody(req)) as Record<string, any>;

      if (p === '/local/register') {
        const conn = core.newConnId();
        const ccPid = Number.isInteger(body.cc_pid) ? (body.cc_pid as number) : null;
        const cwd = typeof body.cwd === 'string' ? body.cwd : null;
        const s = typeof body.session_id === 'string' ? core.cc.getSession(body.session_id) : core.cc.correlate({ ccPid, cwd });
        // `probe` (the CLI) only wants to know its session; MCP servers keep a connection.
        if (body.probe !== true) {
          conns.set(conn, { sessionId: s?.session_id ?? null, cwd, ccPid });
          if (s) core.bindConnection(conn, s.session_id);
        }
        return send(res, 200, { conn, session_id: s?.session_id ?? null, digest: core.digest(s?.session_id ?? null) });
      }

      if (p === '/local/ack') {
        const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n: number) => Number.isInteger(n)) : [];
        return send(res, 200, { acked: core.cc.ack(ids, typeof body.via === 'string' ? body.via : 'tool') });
      }

      const hook = /^\/local\/hook\/(SessionStart|UserPromptSubmit|Stop|SessionEnd)$/.exec(p);
      if (hook) {
        const h = body as any;
        const out =
          hook[1] === 'SessionStart' ? hookSessionStart(core, h) : hook[1] === 'UserPromptSubmit' ? hookUserPrompt(core, h) : hook[1] === 'Stop' ? hookStop(core, h) : hookSessionEnd(core, h);
        return send(res, 200, out);
      }

      const tool = /^\/local\/tool\/([a-z0-9_]+)$/.exec(p);
      if (tool) {
        const ctx = ctxFor(body.conn, body);
        const ac = new AbortController();
        req.on('close', () => {
          if (!res.writableEnded) ac.abort();
        });
        const text = await runTool(core, tool[1], (body.args ?? {}) as Record<string, any>, ctx, ac.signal);
        return send(res, 200, { text });
      }

      // ---- CLI-only routes (slash commands) -------------------------------------
      const ctx = ctxFor(null, body);
      if (p === '/local/pair') {
        if (body.action === 'revoke') return send(res, 200, { text: await opRevoke(core, body as any) });
        if (typeof body.code === 'string' && body.code.trim()) return send(res, 200, { text: await opRedeem(core, body as any) });
        return send(res, 200, { text: opInvite(core) });
      }
      if (p === '/local/trust') return send(res, 200, { text: opTrust(core, body, ctx) });
      if (p === '/local/label') {
        if (!ctx.sessionId) return send(res, 200, { text: 'error: no Claude Code session is registered for this folder yet.' });
        core.cc.setLabel(ctx.sessionId, typeof body.label === 'string' ? body.label : null);
        return send(res, 200, { text: `This session is now labelled "${body.label ?? ''}" for peers (they can target it with to_session).` });
      }
      if (p === '/local/status') {
        const s = ctx.sessionId ? core.cc.getSession(ctx.sessionId) : undefined;
        const mode = s?.channel_ok === 1 ? 'channel (push) mode' : s?.channel_ok === 0 ? 'hook mode (channels appear to be off: messages arrive on your next prompt)' : 'unknown (no item has been delivered yet)';
        const lines = [
          `A2A endpoint: ${core.node.isRunning() ? core.node.origin() : 'not running'} (certificate sha256 ${core.node.fingerprint().slice(0, 16)}...)`,
          `This session: ${s ? `${s.session_id.slice(0, 8)} in ${s.cwd ?? '?'}, label "${s.label ?? s.project ?? ''}"` : 'not registered'}`,
          `Delivery: ${mode}`,
          relayLine(core.node.relayStatus()),
          core.digest(ctx.sessionId),
        ];
        return send(res, 200, { text: lines.join('\n') });
      }
      if (p === '/local/log') {
        const n = Math.min(500, Math.max(1, Number(body.n) || 30));
        return send(res, 200, { text: core.node.audit.tail(n).map((e) => JSON.stringify(e)).join('\n') || '(audit log is empty)' });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 500, { error: (e as Error).message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}
