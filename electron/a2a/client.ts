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
import { RelayDroppedError, RelayUnavailableError, type RelayClient } from './relayClient';
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
  /**
   * How to reach this peer through the relay when direct fails (design 11a).
   * Omitted = no relay (today's behaviour). A `relay://<fingerprint>` baseUrl
   * means the peer has no direct address at all and always goes this way.
   */
  relay?: RelayRoute;
}

export interface RelayRoute {
  /** Our relay connection; null when the relay is not configured or not enabled. */
  client: RelayClient | null;
  /** The pair key, or null when it cannot be had (see `unavailable`). */
  key: Buffer | null;
  /** Why the relay cannot carry this peer's traffic (e.g. paired before relay support; re-pair). */
  unavailable?: string;
  /** Pairing request: our public key rides in front of the ciphertext (relayClient.ts). */
  pairing?: boolean;
  /** The relay the peer uses, when known (pairing code), for a precise error if ours differs. */
  expectedUrl?: string;
}

export const RELAY_SCHEME = 'relay:';

const DEFAULT_TIMEOUT_MS = 10_000;
const RELAY_DIRECT_CONNECT_MS = 4_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

const OFFLINE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/** "https://h:p/anything" -> origin. Card URLs point at the card; calls go to the origin. */
export function baseUrlOf(cardOrBaseUrl: string): string {
  const u = new URL(cardOrBaseUrl);
  return `${u.protocol}//${u.host}`;
}

/**
 * One A2A call. Direct first, exactly as before the relay existed; on
 * PeerOfflineError (and only that) fall back to the relay when this peer has
 * a usable relay route. A CertPinMismatchError is NEVER relayed: it is thrown
 * before any fallback is considered.
 */
export async function a2aRequest<T>(
  ep: PeerEndpoint,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<T> {
  const u = new URL(path, ep.baseUrl);
  if (u.protocol === RELAY_SCHEME) return viaRelay<T>(ep, method, u, body, opts, null);
  const r = ep.relay;
  const origin = `${u.protocol}//${u.host}`;
  // A peer behind a VPN gateway drops packets rather than refusing them, so
  // each direct attempt costs the full connect timeout. After one fails, use
  // the relay straight away for a couple of minutes.
  if (r?.client && r.key && !r.unavailable && r.client.isConnected() && r.client.directRecentlyDown(origin)) {
    return viaRelay<T>(ep, method, u, body, opts, null);
  }
  // With a working relay behind us, do not spend the full timeout dialing a
  // peer that a VPN gateway silently drops: give the TCP+TLS connect 4 s.
  const relayReady = !!(r?.client && r.key && !r.unavailable && r.client.isConnected());
  const connectTimeoutMs = relayReady ? Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, RELAY_DIRECT_CONNECT_MS) : undefined;
  try {
    return await directRequest<T>(ep, method, u, body, opts, connectTimeoutMs);
  } catch (e) {
    if (!(e instanceof PeerOfflineError) || !r) throw e;
    if (r.client) r.client.noteDirectDown(origin);
    return viaRelay<T>(ep, method, u, body, opts, e);
  }
}

function a2aHeaders(ep: PeerEndpoint, opts: { headers?: Record<string, string> }, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'A2A-Version': A2A_PROTOCOL_VERSION,
    Accept: `${A2A_CONTENT_TYPE}, application/json`,
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (v) headers[k] = v;
  if (ep.token) headers.Authorization = `Bearer ${ep.token}`;
  if (hasBody) headers['Content-Type'] = A2A_CONTENT_TYPE;
  return headers;
}

function statusToResult<T>(status: number, parsed: unknown): T {
  if (status >= 200 && status < 300 && parsed !== undefined) return parsed as T;
  const errBody = (parsed as A2AErrorBody | undefined)?.error;
  const reason = errBody?.details?.[0]?.reason;
  throw new A2AClientError(errBody?.message || `HTTP ${status}`, status, reason);
}

async function viaRelay<T>(
  ep: PeerEndpoint,
  method: 'GET' | 'POST',
  u: URL,
  body: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> },
  directErr: PeerOfflineError | null
): Promise<T> {
  const r = ep.relay;
  const lead = directErr ? directErr.message : `${ep.certSha256.slice(0, 12)}... is reachable only through the relay.`;
  if (!r || !r.client) {
    const hint = r?.expectedUrl ? ` They use the relay ${r.expectedUrl}: turn the relay on with that URL (Agents panel) and try again.` : directErr ? '' : ' Turn the relay on (Agents panel) to reach them.';
    throw new PeerOfflineError(`${lead}${hint}`);
  }
  if (r.unavailable || !r.key) throw new PeerOfflineError(`${lead} The relay cannot carry it: ${r.unavailable ?? 'no relay key for this peer'}.`);
  if (r.expectedUrl && r.expectedUrl !== r.client.url) {
    throw new PeerOfflineError(`${lead} They use the relay ${r.expectedUrl}, but this agent is set to ${r.client.url}.`);
  }
  if (!r.client.isConnected()) {
    const st = r.client.status();
    throw new PeerOfflineError(`${lead} The relay is ${st.state}${st.lastError ? ` (${st.lastError})` : ''}.`);
  }
  try {
    const res = await r.client.request(
      ep.certSha256,
      r.key,
      { method, path: u.pathname + u.search, headers: a2aHeaders(ep, opts, body !== undefined), body },
      { pairing: r.pairing }
    );
    return statusToResult<T>(Number(res?.status) || 0, res?.body ?? {});
  } catch (e) {
    if (e instanceof RelayUnavailableError || e instanceof RelayDroppedError) throw new PeerOfflineError(`${lead} Via the relay: ${e.message}`);
    throw e;
  }
}

async function directRequest<T>(
  ep: PeerEndpoint,
  method: 'GET' | 'POST',
  u: URL,
  body: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> },
  connectTimeoutMs?: number
): Promise<T> {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');

  let socket: net.Socket | undefined;
  if (isHttps) {
    try {
      socket = await connectPinned({ host, port, fingerprint: ep.certSha256, timeoutMs: connectTimeoutMs ?? timeoutMs });
    } catch (e) {
      if (e instanceof CertPinMismatchError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code && OFFLINE_CODES.has(code)) throw new PeerOfflineError(`${u.host} is unreachable (${code}).`);
      throw e;
    }
  }

  const headers: Record<string, string | number> = a2aHeaders(ep, opts, !!payload);
  if (payload) headers['Content-Length'] = payload.length;

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
          try {
            resolve(statusToResult<T>(res.statusCode ?? 0, parsed));
          } catch (e) {
            reject(e);
          }
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
