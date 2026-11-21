/**
 * Outbound A2A calls with a pinned TLS certificate.
 *
 * Every request:
 *   - opens its own TLS socket via `connectPinned`, which verifies the peer's
 *     certificate fingerprint BEFORE any bytes (including the bearer token)
 *     are written. A mismatch throws CertPinMismatchError and is never
 *     retried or auto-accepted (design 6.6): the user must re-pair;
 *   - sends `A2A-Version: 1.0` and `Content-Type: application/a2a+json`;
 *   - has a hard timeout, so a dead peer cannot hang a tool call.
 *
 * This module makes exactly one attempt. Retries, backoff and the offline
 * outbox live in node.ts / push.ts (design 6.6), which classify the errors
 * thrown here: PeerOfflineError and 5xx / 408 / 429 are worth retrying; any
 * other 4xx and a pin mismatch are not.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import { connectPinned, CertPinMismatchError } from './tls';
import type { A2AErrorBody, AgentCard, PairRequest, PairResponse, SendMessageRequest, SendMessageResponse, StreamResponse, Task } from './types';
import { A2A_CONTENT_TYPE, A2A_PROTOCOL_VERSION, PUSH_TOKEN_HEADER } from './types';

export { CertPinMismatchError };

export class A2AClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string
  ) {
    super(message);
    this.name = 'A2AClientError';
  }
}

/** Connection-level failure: the peer is unreachable (offline, VPN down, wrong port). */
export class PeerOfflineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerOfflineError';
  }
}

export interface PeerEndpoint {
  /** Base URL, e.g. https://10.30.1.23:7427 (the card URL minus its path). */
  baseUrl: string;
  /** SHA-256 hex of the peer's certificate DER. Ignored for http:// (tests only). */
  certSha256: string;
  /** Bearer token for this peer. Omit for the public card and pairing. */
  token?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const OFFLINE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/** "https://h:p/anything" -> origin. Card URLs point at the card; calls go to the origin. */
export function baseUrlOf(cardOrBaseUrl: string): string {
  const u = new URL(cardOrBaseUrl);
  return `${u.protocol}//${u.host}`;
}

export async function a2aRequest<T>(
  ep: PeerEndpoint,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<T> {
  const u = new URL(path, ep.baseUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');

  let socket: net.Socket | undefined;
  if (isHttps) {
    try {
      socket = await connectPinned({ host, port, fingerprint: ep.certSha256, timeoutMs });
    } catch (e) {
      if (e instanceof CertPinMismatchError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code && OFFLINE_CODES.has(code)) throw new PeerOfflineError(`${u.host} is unreachable (${code}).`);
      throw e;
    }
  }

  const headers: Record<string, string | number> = {
    'A2A-Version': A2A_PROTOCOL_VERSION,
    Accept: `${A2A_CONTENT_TYPE}, application/json`,
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (v) headers[k] = v;
  if (ep.token) headers.Authorization = `Bearer ${ep.token}`;
  if (payload) {
    headers['Content-Type'] = A2A_CONTENT_TYPE;
    headers['Content-Length'] = payload.length;
  }

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method,
        path: u.pathname + u.search,
        headers,
        // NOTE: no `agent` key. Node uses `createConnection` only when no agent
        // is given; `agent: false` silently creates a fresh Agent that dials its
        // own unpinned socket. For http:// (tests) the per-request socket
        // still comes from a throwaway agent so nothing is pooled.
        ...(socket ? { createConnection: () => socket! } : { agent: false }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('A2A response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = undefined;
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300 && parsed !== undefined) {
            resolve(parsed as T);
            return;
          }
          const errBody = (parsed as A2AErrorBody | undefined)?.error;
          const reason = errBody?.details?.[0]?.reason;
          reject(new A2AClientError(errBody?.message || `HTTP ${status}`, status, reason));
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('A2A request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code && OFFLINE_CODES.has(e.code)) reject(new PeerOfflineError(`${u.host} is unreachable (${e.code}).`));
      else reject(e);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function fetchCard(ep: PeerEndpoint, timeoutMs?: number): Promise<AgentCard> {
  return a2aRequest<AgentCard>({ ...ep, token: undefined }, 'GET', '/.well-known/agent-card.json', undefined, { timeoutMs });
}

export function fetchExtendedCard(ep: PeerEndpoint, timeoutMs?: number): Promise<AgentCard & Record<string, unknown>> {
  return a2aRequest(ep, 'GET', '/extendedAgentCard', undefined, { timeoutMs });
}

export function sendMessage(ep: PeerEndpoint, req: SendMessageRequest): Promise<SendMessageResponse> {
  return a2aRequest<SendMessageResponse>(ep, 'POST', '/message:send', req);
}

export function getTask(ep: PeerEndpoint, taskId: string): Promise<Task> {
  return a2aRequest<Task>(ep, 'GET', `/tasks/${encodeURIComponent(taskId)}`);
}

export function cancelTask(ep: PeerEndpoint, taskId: string): Promise<Task> {
  return a2aRequest<Task>(ep, 'POST', `/tasks/${encodeURIComponent(taskId)}:cancel`, {});
}

/**
 * Deliver one push notification (a StreamResponse) to the peer that asked
 * for it. `path` is the path of the URL they registered; the origin is always
 * the peer's own pinned endpoint (node.ts refuses any other origin when the
 * config is registered), so the token can only ever go to them.
 */
export function postPush(ep: PeerEndpoint, path: string, body: StreamResponse, pushToken: string | null, timeoutMs?: number): Promise<unknown> {
  return a2aRequest(ep, 'POST', path, body, { timeoutMs, headers: pushToken ? { [PUSH_TOKEN_HEADER]: pushToken } : {} });
}

/** Best-effort "we unpaired you" (design 4.3 step 5), on our pairing extension. */
export function notifyUnpair(ep: PeerEndpoint, timeoutMs = 3000): Promise<unknown> {
  return a2aRequest(ep, 'POST', '/a2a-unpair', {}, { timeoutMs });
}

/** Retry-worthy failure? Offline, timeouts, 5xx, 408, 429. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof PeerOfflineError) return true;
  if (e instanceof CertPinMismatchError) return false;
  if (e instanceof A2AClientError) return e.status >= 500 || e.status === 408 || e.status === 429 || e.status === 0;
  return true; // socket-level oddities: try again
}

export function redeemPairing(ep: PeerEndpoint, req: PairRequest): Promise<PairResponse> {
  return a2aRequest<PairResponse>({ ...ep, token: undefined }, 'POST', '/a2a-pair', req);
}
