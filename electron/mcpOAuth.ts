// OAuth glue for HTTP MCP servers (slack, etc.).
//
// The MCP SDK's StreamableHTTPClientTransport accepts an OAuthClientProvider.
// We implement that interface here, persisting tokens / client info / PKCE
// verifier in our SQLite settings table (one row per server) so connections
// survive app restarts.
//
// Authorization callback flow:
//   1. SDK calls redirectToAuthorization(url). We spin up a tiny HTTP server
//      on the plugin's callbackPort, open `url` in the user's browser via
//      Electron's shell.openExternal, and resolve a Promise when the
//      browser hits our callback with `?code=...`.
//   2. The caller (mcp.ts) catches the UnauthorizedError, awaits the code
//      via getPendingAuthCode(serverName), and calls transport.finishAuth(code).
//   3. SDK exchanges the code for tokens and calls saveTokens(t). Then we
//      reconnect.
//
// Tokens are persisted in plain DB settings. That's fine for now — the same
// surface as the Anthropic API key, just one tier less protected. We can
// upgrade to safeStorage later when we add a key migration step.

import { shell } from 'electron';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import log from 'electron-log';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { getSetting, setSetting } from './db';

interface PendingCallback {
  port: number;
  server: Server;
  resolve: (code: string) => void;
  reject: (e: Error) => void;
}

const _pendingCallbacks = new Map<string, PendingCallback>(); // serverName → state

// ---- Persistence helpers ----------------------------------------------------

function settingKey(serverName: string, suffix: string): string {
  return `mcp.oauth.${serverName}.${suffix}`;
}

function readJson<T>(serverName: string, suffix: string): T | undefined {
  const raw = getSetting(settingKey(serverName, suffix));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    log.warn(`[mcp/oauth] failed to parse ${suffix} for ${serverName}`, e);
    return undefined;
  }
}

function writeJson(serverName: string, suffix: string, value: unknown): void {
  setSetting(settingKey(serverName, suffix), JSON.stringify(value));
}

function readString(serverName: string, suffix: string): string | undefined {
  const raw = getSetting(settingKey(serverName, suffix));
  return raw && raw.trim() ? raw : undefined;
}

function writeString(serverName: string, suffix: string, value: string): void {
  setSetting(settingKey(serverName, suffix), value);
}

// ---- Provider implementation ------------------------------------------------

interface ProviderOpts {
  serverName: string;
  /** Pre-registered clientId from the plugin's `.mcp.json`. May be omitted to use DCR. */
  staticClientId?: string;
  /** Callback port from the plugin's `.mcp.json`. */
  callbackPort: number;
  /**
   * Space-separated OAuth scope string. Mirrors `clientMetadata.scope`
   * in the MCP SDK and is forwarded both to the dynamic client
   * registration body and the authorization URL.
   *
   * When set, this is the fallback in the SDK's scope-selection order:
   *   1. WWW-Authenticate scope header (if the server returned one)
   *   2. resourceMetadata.scopes_supported (if discovery succeeded)
   *   3. This value (clientMetadata.scope)
   *
   * For servers whose resource metadata advertises only read scopes
   * but actually supports write (e.g. Atlassian's MCP — the default
   * discovery scopes are read-only, but the OAuth app supports
   * `write:confluence-content` etc.), supplying scope here is the
   * only way to actually get write tokens.
   */
  scope?: string;
  /**
   * Hostname to embed in the redirect URI we hand to the authorization
   * server. Defaults to `localhost` because that's the form most OAuth
   * providers register for loopback flows. The local listener still
   * binds to `127.0.0.1` regardless — `localhost` resolves to IPv4
   * loopback on Windows/macOS/Linux out of the box, so the browser
   * still reaches us.
   *
   * Slack-specific note: the shared Anthropic client ID
   * `1601185624273.8899143856786` is registered with `localhost`-form
   * URIs in Slack's OAuth app. Passing `127.0.0.1` triggers Slack's
   * "redirect_uri did not match any configured URIs" error page.
   */
  redirectHost?: string;
}

export class GuyOAuthProvider implements OAuthClientProvider {
  readonly serverName: string;
  private readonly _callbackPort: number;
  private readonly _staticClientId?: string;
  private readonly _scope?: string;
  private readonly _redirectHost: string;
  /**
   * When true, redirectToAuthorization is a no-op so the connect attempt
   * fails fast with UnauthorizedError without opening the user's browser.
   * Set to true during initMcp (so we don't auto-open browser tabs at app
   * startup); the renderer flips it false via setInteractive(true) right
   * before invoking signInMcp.
   */
  private _interactive = false;

  constructor(opts: ProviderOpts) {
    this.serverName = opts.serverName;
    this._callbackPort = opts.callbackPort;
    this._staticClientId = opts.staticClientId;
    this._scope = opts.scope;
    // `localhost` is the safe default — Slack, Atlassian, Linear etc.
    // all register loopback URIs in their hostname form. Servers that
    // genuinely registered the IPv4 literal can opt back in via the
    // `redirectHost` field in their `oauth` block of `mcp.json`.
    this._redirectHost = opts.redirectHost ?? 'localhost';
  }

  setInteractive(v: boolean): void {
    this._interactive = v;
  }

  /**
   * The OAuth redirect URI we hand to the authorization server. Must
   * EXACTLY match one of the URIs the server's OAuth app has
   * pre-registered (Slack, GitHub, Atlassian etc. all enforce strict
   * string equality including scheme, host, port, path).
   *
   * The local HTTP server stays bound to `127.0.0.1` (see
   * `startCallbackListener`) for security; the hostname is just what
   * we tell the authorization server to redirect the browser to.
   */
  get redirectUrl(): string {
    return `http://${this._redirectHost}:${this._callbackPort}/callback`;
  }

  // Identifies this client to the authorization server. For pre-registered
  // plugins (slack) the clientId is fixed; for dynamic registration the SDK
  // will call saveClientInformation() after registering.
  //
  // `scope` is included here only when the user configured one. It feeds
  // into both the DCR registration body and the authorization URL's
  // `scope` param. Without it, the SDK falls back to the server's
  // resource metadata, which for some servers (Atlassian) advertises a
  // read-only scope set even when the OAuth app would happily grant
  // write scopes if asked.
  get clientMetadata(): OAuthClientMetadata {
    const base: OAuthClientMetadata = {
      client_name: 'Guy Code',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client, PKCE-protected
    };
    if (this._scope) {
      (base as OAuthClientMetadata & { scope: string }).scope = this._scope;
    }
    return base;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const saved = readJson<OAuthClientInformationMixed>(this.serverName, 'client');
    if (saved) return saved;
    if (this._staticClientId) {
      return { client_id: this._staticClientId } as OAuthClientInformationMixed;
    }
    return undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    writeJson(this.serverName, 'client', info);
  }

  tokens(): OAuthTokens | undefined {
    return readJson<OAuthTokens>(this.serverName, 'tokens');
  }

  saveTokens(tokens: OAuthTokens): void {
    writeJson(this.serverName, 'tokens', tokens);
    // Log granted scopes loudly. This is the primary diagnostic for
    // "why can't I write to <thing>?" — if the user expected write
    // access but the granted scope set is read-only, that's the root
    // cause. Some servers (Atlassian) return scope as a space-joined
    // string in the token response; others omit it entirely (in which
    // case the user has to assume the requested scope was honored).
    const grantedScope = (tokens as OAuthTokens & { scope?: string }).scope;
    log.info(
      `[mcp/oauth:${this.serverName}] tokens saved; granted scope: ${grantedScope ?? '(not reported by server)'}; requested: ${this._scope ?? '(none — using server defaults)'}`
    );
  }

  /**
   * Wipe all saved credentials for this server. Used by the renderer's
   * "Sign out" affordance. After this, the next signIn call will go
   * through the full DCR + authorize flow with whatever scope the
   * current provider has configured — i.e. the user can change scope
   * in their `.mcp.json`, call signOut, then signIn, and end up with
   * fresh tokens reflecting the new scope.
   */
  signOut(): void {
    log.info(`[mcp/oauth:${this.serverName}] signing out — clearing all credentials`);
    this.invalidateCredentials('all');
  }

  saveCodeVerifier(codeVerifier: string): void {
    writeString(this.serverName, 'codeVerifier', codeVerifier);
  }

  codeVerifier(): string {
    const v = readString(this.serverName, 'codeVerifier');
    if (!v) {
      // Should never happen in a well-formed flow; the SDK calls
      // saveCodeVerifier before the redirect.
      throw new Error(
        `[mcp/oauth:${this.serverName}] no code verifier — restart the sign-in flow`
      );
    }
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    log.info(`[mcp/oauth:${this.serverName}] invalidate(${scope})`);
    const clear = (suf: string) => setSetting(settingKey(this.serverName, suf), '');
    if (scope === 'tokens' || scope === 'all') clear('tokens');
    if (scope === 'verifier' || scope === 'all') clear('codeVerifier');
    if (scope === 'client' || scope === 'all') clear('client');
    if (scope === 'discovery' || scope === 'all') clear('discovery');
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this._interactive) {
      // We're connecting silently (e.g. at app startup). Bail without
      // opening a browser tab; the SDK will surface UnauthorizedError and
      // mcp.ts will set status='needs-auth' so the user can click "Sign in"
      // when they're ready.
      log.info(
        `[mcp/oauth:${this.serverName}] silent connect — skipping browser redirect`
      );
      return;
    }
    // Start (or reuse) the local listener for this server's callback port,
    // then kick the user out to their browser. The MCP SDK throws
    // UnauthorizedError after this resolves; the caller (mcp.ts) is
    // responsible for awaiting getPendingAuthCode() and calling finishAuth.
    startCallbackListener(this.serverName, this._callbackPort);
    log.info(
      `[mcp/oauth:${this.serverName}] opening browser to ${authorizationUrl.origin}/...`
    );
    await shell.openExternal(authorizationUrl.toString());
  }
}

// ---- Callback listener ------------------------------------------------------

function startCallbackListener(serverName: string, port: number): void {
  // If a listener is already running for this server, leave it alone.
  if (_pendingCallbacks.has(serverName)) return;

  let resolve!: (code: string) => void;
  let reject!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(renderCallbackHtml(`Authorization failed: ${err}`, true));
        reject(new Error(`OAuth error: ${err}`));
        return;
      }
      if (!code) {
        // Probably a favicon hit or noise — ignore politely.
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        renderCallbackHtml(
          `Connected ${serverName} to Guy Code. You can close this tab.`,
          false
        )
      );
      resolve(code);
    } catch (e: any) {
      reject(e);
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(e?.message ?? e));
      } catch {
        /* ignore */
      }
    }
  });

  server.on('error', (e) => {
    log.error(`[mcp/oauth:${serverName}] callback server error`, e);
    reject(e);
  });

  server.listen(port, '127.0.0.1', () => {
    log.info(`[mcp/oauth:${serverName}] listening on 127.0.0.1:${port}`);
  });

  const cb: PendingCallback = { port, server, resolve, reject };
  _pendingCallbacks.set(serverName, cb);

  // Don't keep the entire process pegged on this — auto-shut after 5 min.
  const timeout = setTimeout(
    () => {
      if (_pendingCallbacks.get(serverName) === cb) {
        log.warn(`[mcp/oauth:${serverName}] callback timeout, shutting down listener`);
        stopCallbackListener(serverName);
        reject(new Error('OAuth callback timed out'));
      }
    },
    5 * 60 * 1000
  );

  // Make sure we tear down once the code lands or the promise rejects.
  codePromise.finally(() => {
    clearTimeout(timeout);
    setTimeout(() => stopCallbackListener(serverName), 250);
  });

  // Stash the promise on the pending state by replacing the resolve/reject
  // wrappers with ones that forward.
  // (Caller reads it back via getPendingAuthCode below.)
  (cb as any)._codePromise = codePromise;
}

function stopCallbackListener(serverName: string): void {
  const cb = _pendingCallbacks.get(serverName);
  if (!cb) return;
  _pendingCallbacks.delete(serverName);
  try {
    cb.server.close();
  } catch {
    /* ignore */
  }
}

/**
 * Wait for the authorization code for `serverName`. Resolves with the code
 * once the browser hits our local callback, rejects on timeout or error.
 * Must be called after the SDK has invoked redirectToAuthorization (which
 * started the listener).
 */
export function getPendingAuthCode(serverName: string): Promise<string> {
  const cb = _pendingCallbacks.get(serverName);
  if (!cb) {
    return Promise.reject(
      new Error(`No pending OAuth callback for ${serverName} — flow not started?`)
    );
  }
  const p: Promise<string> | undefined = (cb as any)._codePromise;
  if (!p) {
    return Promise.reject(
      new Error(`Pending callback for ${serverName} is in an inconsistent state`)
    );
  }
  return p;
}

function renderCallbackHtml(message: string, isError: boolean): string {
  const color = isError ? '#dc2626' : '#16a34a';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Guy Code</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background:#0e0f12; color:#e5e7eb;
         display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { max-width:420px; padding:32px; border:1px solid #1f2937; border-radius:12px; text-align:center; }
  .dot { width:10px; height:10px; border-radius:50%; background:${color}; display:inline-block; margin-right:8px; vertical-align:middle; }
  h1 { font-size:18px; margin:0 0 12px; font-weight:600; }
  p { font-size:13px; color:#9ca3af; margin:0; }
</style>
</head><body><div class="card"><h1><span class="dot"></span>${escapeHtml(message)}</h1><p>You can close this tab and return to Guy Code.</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
