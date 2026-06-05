/**
 * Chrome connector — extension transport.
 *
 * This is the second implementation of the Chrome connector. The
 * first (`chromeBridge.ts`) drives Chrome via CDP-over-TCP using
 * `playwright-core` and `--remote-debugging-port`. That works on
 * fresh Chrome profiles but Chrome 136+ silently disables the debug
 * port on a default signed-in profile (anti-cookie-theft measure),
 * which is exactly the profile the user wants to drive — their
 * logged-in Gmail / Slack / Outlook session.
 *
 * The extension transport gets around this by NOT being CDP at all.
 * The user installs a tiny Manifest-V3 extension
 * (`chrome-extension/`) into their normal Chrome. The extension uses
 * Chrome's first-party `chrome.tabs` and `chrome.scripting` APIs to
 * read and drive tabs from inside the browser process — code paths
 * that are NOT subject to the anti-debug-port check. The extension's
 * service worker is a WebSocket client; this module is the WebSocket
 * SERVER (bound to 127.0.0.1:9223, see `chromeWsServer.ts`). We send
 * the extension JSON-RPC requests over the WS and it executes them.
 *
 * Public API parity:
 *   The exports here intentionally MIRROR `chromeBridge.ts` so the
 *   rest of the app can swap one for the other without changes:
 *
 *     getStatus(), connect(port?), disconnect(),
 *     listTabs(), openTab(url),
 *     extractTab(args), screenshotTab(args), waitForTab(args),
 *     clickTab(args), typeTab(args), pressTab(args),
 *     scrollTab(args), evalTab(args).
 *
 *   `electron/tools.ts` and `electron/ipc.ts` reach in via
 *   `await import('./chromeBridge')` (dynamic) — the final cut-over
 *   is a one-line re-export change inside `chromeBridge.ts` (and a
 *   matching tests file rewrite). The actual implementation lives
 *   here.
 *
 * Lifecycle:
 *   connect(port):
 *     - If the WS server isn't already running, start it on `port`
 *       (default 9223). Listens on 127.0.0.1 only.
 *     - Wait up to 30 seconds for the extension's service worker to
 *       initiate a WS connection. The SW connects on extension
 *       install / browser startup / on every wake; if the user has
 *       the extension loaded and Chrome is running, it'll connect
 *       within a few seconds. If not — e.g. they forgot to load the
 *       extension — we time out with an actionable error.
 *     - Once we've received the extension's `hello` message we set
 *       status='connected' and resolve.
 *
 *   disconnect():
 *     - Stop the WS server, which displaces any active connection.
 *       Reset state. Idempotent.
 *
 *   Auto-disconnect:
 *     - The WS server emits `disconnect` when the active connection
 *       drops (extension unloaded, Chrome killed, network blip). We
 *       set status='disconnected' so the next tool call surfaces a
 *       clear error AND the Settings UI flips its pill.
 *     - The extension auto-reconnects with backoff. When it comes
 *       back, the WS server emits `connect` and we restore status.
 *
 * Tool error contract:
 *   Same as `chromeBridge.ts`. Every tool method either resolves
 *   with the success value or throws an Error whose message starts
 *   with "Chrome connector: ...". The agent's tool executor catches
 *   the throw and surfaces it verbatim.
 */
import log from 'electron-log';
import { createWsServer, type WsConnection, type WsServer } from './chromeWsServer';
import { EXTENSION_BUILD, isExtensionStale } from './extVersion';

/**
 * Optional injectable approval prompter. Production wiring (set in
 * `electron/main.ts` after the main window is ready) shows a native
 * `dialog.showMessageBox` modal asking the user to approve attaching
 * to a specific tab. Tests inject a mock that resolves with a
 * predetermined answer so authorization paths are deterministic.
 *
 * Returns:
 *   - `true`  → user approved; bridge proceeds with authorization.
 *   - `false` → user denied (or closed the dialog); bridge throws.
 */
export type AttachApprovalPrompter = (info: {
  tabId: string;
  url: string;
  title: string;
}) => Promise<boolean>;

let _attachApprovalPrompter: AttachApprovalPrompter | null = null;

/**
 * Wire in the production approval prompter at app startup. Bridge
 * calls this exactly once after `electron`'s `app` is ready and the
 * main window has been created.
 *
 * If never set, `BrowserAttach` will fail closed (deny by default) —
 * the agent must use `BrowserOpen` for its own tabs. Failing closed
 * is the right call: silent auto-approval is exactly the bug we're
 * fixing.
 */
export function setAttachApprovalPrompter(p: AttachApprovalPrompter | null): void {
  _attachApprovalPrompter = p;
}

/** @internal — exposed only for tests so they can read the current handler. */
export function _getAttachApprovalPrompterForTest(): AttachApprovalPrompter | null {
  return _attachApprovalPrompter;
}

/**
 * Default WebSocket port. NOT the same as CDP's 9222 — we're a
 * different protocol and want to make it obvious in the wire that
 * this is the extension transport, not raw CDP. 9223 is the next
 * number up and not commonly used.
 */
export const DEFAULT_WS_PORT = 9223;

/**
 * Default 15s tool-action timeout, mirroring `chromeBridge.ts` and
 * `webFetch.ts`. Per-RPC timeout can be overridden by the agent (e.g.
 * BrowserWaitFor's timeoutMs).
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Maximum DOM-extraction text length per call. 200K chars (~50K tokens)
 * matches `chromeBridge.ts`. The extension also enforces this on its
 * side but we double-check here because the extension's view of "200K
 * chars" can be UTF-16 code units while ours is UTF-8 code points.
 */
const MAX_EXTRACT_CHARS = 200_000;

/**
 * Wait this long for the extension to come online during `connect`.
 * 30 seconds is generous — the extension's service worker can take a
 * moment to wake up from MV3 idle, especially right after a Chrome
 * restart. If the user actually has the extension loaded this is
 * plenty.
 */
const CONNECT_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Per-RPC default timeout. Longer than tool-action timeout because
 * the action timeout is enforced extension-side; this is the
 * pessimistic outer envelope (network blip + extension wake-up).
 */
const RPC_DEFAULT_TIMEOUT_MS = 30_000;

interface BridgeState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  port: number | null;
  server: WsServer | null;
  connection: WsConnection | null;
  /** Last error message; surfaced in `getStatus()` for the UI. */
  error: string | null;
  connectedAt: number | null;
  /** Best-effort cache of the extension's last self-reported tab count. */
  lastTabCount: number;
  /**
   * Behavioral build number the connected extension reported in its `hello`
   * handshake, or null if it reported none (a pre-handshake / very old
   * extension). Compared against EXTENSION_BUILD to detect a stale extension.
   * Reset to null on disconnect.
   */
  extensionBuild: number | null;
  /**
   * Tab ids the agent is allowed to operate on with write tools
   * (Click / Type / Press / Scroll / Eval) and Screenshot.
   *
   * Populated by:
   *   - `openTab()` — every tab the agent itself opens is auto-added.
   *   - `authorizeTab()` — only callable through the `BrowserAttach`
   *     tool, which the model is instructed to use ONLY when the
   *     user explicitly told it to operate on a pre-existing tab.
   *
   * Read tools (`listTabs`, `extractTab`, `waitForTab`) are NOT gated
   * by this set — passively reading a tab the user opened is fine
   * ("summarize what I'm looking at") and the visible UI signal is
   * very different from hijacking focus or pressing buttons.
   *
   * Cleared by `disconnect()`. We do NOT auto-remove on tab close
   * because we don't get tab-close events from the extension; stale
   * ids in the set are harmless (a future call against a closed
   * tabId fails at the extension with "tab not found" anyway).
   */
  authorizedTabs: Set<string>;
}

const _state: BridgeState = {
  status: 'disconnected',
  port: null,
  server: null,
  connection: null,
  error: null,
  connectedAt: null,
  lastTabCount: 0,
  extensionBuild: null,
  authorizedTabs: new Set<string>(),
};

/**
 * Pending RPC requests indexed by id. Each entry holds the resolver
 * and a timeout timer that rejects if the extension never replies.
 * Cleared when the response comes back OR when the WS disconnects
 * (we reject everything pending with a "connection lost" error).
 */
interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer: NodeJS.Timeout;
}

const _pending = new Map<string, PendingRpc>();
let _nextRpcId = 1;

function nextRpcId(): string {
  return `rpc-${_nextRpcId++}`;
}

// =====================================================================
// Status / lifecycle
// =====================================================================

export interface ChromeStatus {
  status: BridgeState['status'];
  port: number | null;
  error: string | null;
  connectedAt: number | null;
  tabCount: number;
  /** Build the connected extension reported, or null if it reported none. */
  extensionBuild: number | null;
  /** Build the app ships / expects (EXTENSION_BUILD). */
  expectedExtensionBuild: number;
  /**
   * True when connected AND the extension is older than the app's bundled
   * one (or reports no build at all = pre-handshake). Drives the
   * "reload your Chrome extension" warning in Settings.
   */
  extensionStale: boolean;
}

/**
 * Snapshot the current connector state for the renderer / Settings UI.
 * Always returns a fresh object.
 */
export function getStatus(): ChromeStatus {
  return {
    status: _state.status,
    port: _state.port,
    error: _state.error,
    connectedAt: _state.connectedAt,
    tabCount: _state.lastTabCount,
    extensionBuild: _state.extensionBuild,
    expectedExtensionBuild: EXTENSION_BUILD,
    extensionStale: isExtensionStale(_state.status, _state.extensionBuild, EXTENSION_BUILD),
  };
}

/**
 * Bring the connector up. Idempotent: a second call with the same
 * port short-circuits to the existing connection if we're already
 * connected. A call with a different port disconnects first.
 */
export async function connect(port: number = DEFAULT_WS_PORT): Promise<void> {
  // Idempotent path.
  if (_state.status === 'connected' && _state.port === port && _state.connection) {
    log.info(`[chromeExtBridge] already connected on port ${port}; reusing`);
    return;
  }
  // Different port → tear down first.
  if (_state.server) {
    await disconnect();
  }
  _state.status = 'connecting';
  _state.port = port;
  _state.error = null;

  const server = createWsServer({ port });
  _state.server = server;

  // Bind connection lifecycle listeners BEFORE start() so we don't
  // miss the (extremely unlikely) immediate connect after listen.
  server.on('connect', (conn: WsConnection) => {
    log.info(`[chromeExtBridge] extension connected from ${conn.remoteAddress}`);
    _attachConnection(conn);
  });
  server.on('disconnect', () => {
    log.info('[chromeExtBridge] extension disconnected');
    _detachConnection();
  });

  try {
    await server.start();
    // Reflect the ACTUAL bound port back into state. With port=0 the
    // OS picks an ephemeral port and `server.port()` is the only way
    // to learn which one. The Settings UI displays this value and
    // tests use it to know where to connect.
    _state.port = server.port();
    log.info(`[chromeExtBridge] WS server listening on 127.0.0.1:${_state.port}`);
  } catch (e: any) {
    _state.status = 'error';
    _state.error = explainListenError(e, port);
    _state.server = null;
    log.warn(`[chromeExtBridge] listen failed: ${_state.error}`);
    throw new Error(_state.error);
  }

  // Wait for the extension to come online. If it's already running
  // and the user just clicked Connect, this is sub-second; if they
  // need to install or load it, the timeout gives them a clear
  // error to act on.
  try {
    await _waitForExtension(CONNECT_HANDSHAKE_TIMEOUT_MS);
    _state.status = 'connected';
    _state.connectedAt = Date.now();
    log.info('[chromeExtBridge] handshake complete; connector ready');
  } catch (e: any) {
    _state.status = 'error';
    _state.error =
      e?.message ??
      'Chrome connector: extension did not connect within ' +
        `${CONNECT_HANDSHAKE_TIMEOUT_MS}ms. Make sure the Guy Code Bridge ` +
        'extension is loaded in Chrome (chrome://extensions/, Developer ' +
        "mode on, Load unpacked from this repo's chrome-extension/ folder).";
    // Leave the server running — once the extension eventually comes
    // online we'll auto-promote to 'connected' via the connect event.
    // But disconnect-now would give the user a chance to retry with
    // visible feedback; the simpler contract is "throw, the user
    // tries again after fixing the extension".
    log.warn(`[chromeExtBridge] handshake timed out: ${_state.error}`);
    // `_state.error` is typed `string | null`; we just set it on the
    // line above so it's a string here, but TS can't follow that —
    // fall back to a non-empty string for the Error message.
    throw new Error(_state.error ?? 'Chrome connector: extension handshake failed.');
  }
}

/**
 * Tear down the WS server (closes any active connection) and reset
 * state. Idempotent and safe to call when not connected.
 */
export async function disconnect(): Promise<void> {
  const server = _state.server;
  // Reject anything pending immediately, so callers don't hang waiting
  // for an extension that's about to go away.
  _failAllPending('Chrome connector: disconnect requested.');
  _state.status = 'disconnected';
  _state.port = null;
  _state.server = null;
  _state.connection = null;
  _state.connectedAt = null;
  _state.error = null;
  _state.lastTabCount = 0;
  _state.extensionBuild = null;
  // A fresh connect cycle gets a fresh authorization set — we don't
  // assume the user wants the agent to keep operating on the same
  // pre-existing tabs across reconnects (those tabs may even be
  // gone). The agent has to BrowserOpen its own tabs, or the user
  // has to re-authorize via BrowserAttach.
  _state.authorizedTabs.clear();
  if (!server) return;
  try {
    await server.stop();
  } catch (e) {
    log.warn('[chromeExtBridge] server.stop() failed', e);
  }
}

// =====================================================================
// Internal: connection plumbing
// =====================================================================

/** Wire up an extension's WS connection to our message dispatcher. */
function _attachConnection(conn: WsConnection): void {
  _state.connection = conn;
  // Promote status to 'connected'. Covers BOTH the initial connect
  // case (where the explicit connect() function is awaiting
  // `_waitForExtension` and will redundantly set this same value
  // when its await resolves — harmless) AND the auto-reconnect case
  // (extension SW shut down for idleness, then restarted on next
  // alarm and dialed back in). In the auto-reconnect case, nothing
  // else is going to flip status back from 'connecting'; if we
  // don't do it HERE, the bridge stays stuck in 'connecting' even
  // though the WS is healthy and every subsequent tool call fails
  // with "not connected" — which is exactly the bug the user hit
  // after a screenshot RPC (large response → SW briefly idled
  // hard enough to drop → reconnected almost immediately → bridge
  // never noticed it was back).
  _state.status = 'connected';
  _state.connectedAt = Date.now();
  _state.error = null;
  conn.on('message', (text: string) => {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      log.warn(`[chromeExtBridge] non-JSON frame from extension: ${text.slice(0, 200)}`);
      return;
    }
    if (msg && msg.type === 'hello') {
      // The extension says hi on every (re-)connect. Track the UA
      // for logs; if the protocol version ever changes we'd reject
      // mismatched versions here.
      _state.extensionBuild = typeof msg.extBuild === 'number' ? msg.extBuild : null;
      const stale = isExtensionStale(_state.status, _state.extensionBuild, EXTENSION_BUILD);
      log.info(
        `[chromeExtBridge] extension hello: version=${msg.version} ` +
          `extBuild=${_state.extensionBuild ?? 'none'} (app expects ${EXTENSION_BUILD}` +
          `${stale ? '; STALE — user should reload the extension' : ''}) ua=${msg.ua}`
      );
      return;
    }
    if (msg && typeof msg.id === 'string') {
      const pending = _pending.get(msg.id);
      if (!pending) {
        log.warn(`[chromeExtBridge] response for unknown id ${msg.id}; dropping`);
        return;
      }
      clearTimeout(pending.timer);
      _pending.delete(msg.id);
      if ('error' in msg) {
        let errText = String(msg.error);
        // If a capture/readback error comes back from a STALE extension,
        // the most likely fix is reloading the extension (the current build
        // has a chrome.debugger fallback that captures minimized/occluded
        // windows where the old captureVisibleTab readback fails). Append an
        // actionable hint so the model surfaces it to the user instead of
        // retrying forever.
        if (
          /readback|capture|screenshot/i.test(errText) &&
          isExtensionStale(_state.status, _state.extensionBuild, EXTENSION_BUILD)
        ) {
          errText +=
            ' — NOTE: your Chrome extension is out of date (build ' +
            `${_state.extensionBuild ?? 'unknown'}, app expects ${EXTENSION_BUILD}). ` +
            'Reload it at chrome://extensions; the current build captures ' +
            'minimized/occluded windows via a fallback that the loaded one lacks.';
        }
        pending.reject(new Error(`Chrome connector: ${errText}`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    log.warn(`[chromeExtBridge] unexpected frame from extension: ${text.slice(0, 200)}`);
  });
  conn.on('close', () => {
    // Don't double-handle: the WS server's `disconnect` event will
    // call _detachConnection. We do nothing here.
  });
}

function _detachConnection(): void {
  _state.connection = null;
  // The connection dropped; everything in-flight is dead.
  _failAllPending('Chrome connector: extension disconnected mid-call.');
  if (_state.status === 'connected') {
    // We were healthy but the extension went away. Drop to
    // 'connecting' (auto-reconnect is in progress on the extension
    // side) so the UI knows. The Settings poll will pick this up.
    _state.status = 'connecting';
    _state.lastTabCount = 0;
    _state.extensionBuild = null;
  }
}

function _failAllPending(reason: string): void {
  for (const [id, p] of _pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    _pending.delete(id);
  }
}

/**
 * Block until the WS server reports an active connection AND we've
 * received the extension's hello. We don't actually require a
 * specific hello message — receiving ANY frame (including hello)
 * proves the wire is live; the connect event from the server is the
 * trigger.
 */
function _waitForExtension(timeoutMs: number): Promise<void> {
  // Already connected? Resolve immediately.
  if (_state.connection) return Promise.resolve();
  const server = _state.server;
  if (!server) {
    return Promise.reject(
      new Error('Chrome connector: server not started.')
    );
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.off('connect', onConnect);
      reject(
        new Error(
          `Chrome connector: extension did not connect within ${timeoutMs}ms. ` +
            'Make sure Chrome is running and the Guy Code Bridge extension is ' +
            'loaded (chrome://extensions/ → Developer mode → Load unpacked → ' +
            "this repo's chrome-extension/ folder)."
        )
      );
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      server.off('connect', onConnect);
      resolve();
    };
    server.on('connect', onConnect);
  });
}

/** Translate listen() errors into something the user can act on. */
function explainListenError(e: any, port: number): string {
  const msg = String(e?.message ?? e);
  if (msg.includes('EADDRINUSE')) {
    return (
      `Chrome connector: port ${port} is already in use. Another Guy Code ` +
      `instance or process is holding it. Close that process or choose ` +
      `a different port in Settings → Chrome connector.`
    );
  }
  if (msg.includes('EACCES')) {
    return (
      `Chrome connector: port ${port} is not allowed by the OS firewall. ` +
      `Pick a port above 1024.`
    );
  }
  return `Chrome connector: failed to start WS server: ${msg}`;
}

// =====================================================================
// RPC envelope
// =====================================================================

/**
 * Send a JSON-RPC request to the extension and wait for the response.
 * `params` is sent verbatim; the extension validates types on its end.
 *
 * Throws if:
 *   - the connector isn't connected,
 *   - the WS drops before the response arrives, or
 *   - the per-call timeout elapses.
 *
 * Throws with a "Chrome connector: ..." prefix so every tool's error
 * surface is consistent.
 */
async function rpc<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
  const conn = _state.connection;
  if (_state.status !== 'connected' || !conn) {
    throw new Error(
      'Chrome connector: not connected. Open Settings → Chrome connector ' +
        'and click Connect after loading the Guy Code Bridge extension ' +
        '(chrome://extensions/ → Developer mode → Load unpacked).'
    );
  }
  if (!conn.isOpen()) {
    // Status says connected but the socket is gone — the disconnect
    // event hasn't fired yet but will any millisecond. Surface as
    // "not connected" so the user retries.
    throw new Error(
      'Chrome connector: extension connection dropped. Retrying may help; ' +
        'if not, reload the extension from chrome://extensions/.'
    );
  }
  const id = nextRpcId();
  const effectiveTimeout = timeoutMs ?? RPC_DEFAULT_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (_pending.has(id)) {
        _pending.delete(id);
        reject(
          new Error(
            `Chrome connector: ${method} timed out after ${effectiveTimeout}ms`
          )
        );
      }
    }, effectiveTimeout);
    _pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
      method,
      timer,
    });
    try {
      conn.send(JSON.stringify({ id, method, params: params ?? {} }));
    } catch (e: any) {
      clearTimeout(timer);
      _pending.delete(id);
      reject(new Error(`Chrome connector: failed to send ${method}: ${e?.message ?? e}`));
    }
  });
}

// =====================================================================
// Tab authorization
// =====================================================================
//
// The agent is allowed to passively read any tab (extract, list, wait)
// but it can only DRIVE (click, type, press, scroll, eval, screenshot)
// tabs that are in the `authorizedTabs` set. A tab gets into the set
// when the agent itself opened it (BrowserOpen, below) OR when the
// user explicitly told the agent to use a pre-existing tab and the
// agent called the BrowserAttach tool, which lands here.
//
// The rationale is the user's: tabs they have open belong to them. An
// AI shouldn't reach into their logged-in Gmail and start clicking
// buttons unless the user said so. The hard enforcement happens
// here, not in tool descriptions, because tool-description rules
// are only suggestions — bridge-level rejection is unconditional.

/**
 * Mark a tab as authorized for the agent to drive. Intended to be
 * called only from the `BrowserAttach` tool — which the agent should
 * use only when the user explicitly asked to operate on an existing
 * tab. There's no "deauthorize"; the entire set clears on disconnect.
 *
 * We validate the tabId exists in Chrome by issuing a listTabs and
 * checking. That round-trip ensures BrowserAttach with a typo'd or
 * stale tabId fails immediately with a clear error, rather than
 * deferring the failure to the first write tool call.
 */
export async function authorizeTab(tabId: string): Promise<TabInfo> {
  if (!tabId || typeof tabId !== 'string') {
    throw new Error('Chrome connector: BrowserAttach requires `tabId`.');
  }
  const tabs = await listTabs();
  const found = tabs.find((t) => t.id === tabId);
  if (!found) {
    throw new Error(
      `Chrome connector: tab "${tabId}" not found. Call BrowserList to see ` +
        'current tab ids; they change every time Chrome opens a fresh tab.'
    );
  }
  // Hard gate: real user approval, NOT a polite tool description.
  // The previous version of this function trusted the agent to only
  // call BrowserAttach when the user said so; the agent ignored that
  // and started attaching to whatever tab matched its current task.
  // Now we ask the user via a native modal; if they say no (or there
  // is no prompter wired up — e.g. headless tests, broken main
  // window) we fail closed and the agent has to BrowserOpen its own.
  const prompter = _attachApprovalPrompter;
  if (!prompter) {
    throw new Error(
      'Chrome connector: BrowserAttach is not available right now ' +
        '(no approval prompter wired). ' +
        'Use BrowserOpen to make your own tab instead.'
    );
  }
  let approved = false;
  try {
    approved = await prompter({
      tabId: found.id,
      url: found.url,
      title: found.title || '',
    });
  } catch (e) {
    log.warn(`[chromeExtBridge] BrowserAttach prompter threw`, e);
    approved = false;
  }
  if (!approved) {
    throw new Error(
      `Chrome connector: user denied permission to attach to "${tabId}" ` +
        `(${found.url}). ` +
        'You may NOT operate on this tab. ' +
        'Use BrowserOpen with a fresh URL to do your own work in your ' +
        'own tab — that path needs no permission and is always preferred ' +
        "over reaching into the user's tabs."
    );
  }
  _state.authorizedTabs.add(tabId);
  log.info(`[chromeExtBridge] tab ${tabId} authorized for agent operations (user-approved)`);
  return found;
}

/**
 * Test/debug helper to peek at the authorization set. Not surfaced
 * through the renderer.
 */
export function getAuthorizedTabs(): string[] {
  return [..._state.authorizedTabs];
}

/**
 * Internal guard for write tools. Throws a model-readable error with
 * concrete remediation if the tab isn't authorized — the agent's
 * tool-error path surfaces this verbatim, so it sees exactly what
 * to do next (open its own tab, or ask the user).
 *
 * If the bridge isn't connected at all, the not-connected error is
 * more useful (the user has to reconnect before authorization even
 * matters), so we let `rpc()` produce that one. We only fire the
 * authorization-specific error when we're connected AND the tab
 * is missing from the set.
 */
function _assertAuthorized(tabId: string, action: string): void {
  if (_state.status !== 'connected' || !_state.connection) {
    // Defer to rpc()'s clearer "not connected" message. The write
    // tool will fall through to rpc() and throw that one.
    return;
  }
  if (!_state.authorizedTabs.has(tabId)) {
    throw new Error(
      `Chrome connector: not authorized to ${action} on "${tabId}". ` +
        "This tab wasn't opened by you and the user hasn't granted access " +
        'to it. To do your own work, call BrowserOpen with the URL you ' +
        'need — that tab will be auto-authorized. To use an existing ' +
        "user tab, you first need the user's explicit permission and " +
        'then call BrowserAttach with the tabId.'
    );
  }
}

// =====================================================================
// Tab listing
// =====================================================================

export interface TabInfo {
  id: string;
  url: string;
  title: string;
}

export async function listTabs(): Promise<TabInfo[]> {
  const tabs = await rpc<TabInfo[]>('listTabs', {});
  _state.lastTabCount = tabs.length;
  return tabs;
}

// =====================================================================
// Read path
// =====================================================================

export async function openTab(url: string): Promise<TabInfo> {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(`Chrome connector: invalid URL "${url}" (must be http or https).`);
  }
  const tab = await rpc<TabInfo>('openTab', { url });
  // The agent opened it; the agent is allowed to drive it. This is
  // the primary path into `authorizedTabs` — covers the common case
  // where the model says "I'll do this work in my own tab" without
  // bothering the user for permission.
  _state.authorizedTabs.add(tab.id);
  return tab;
}

export async function extractTab(args: {
  tabId: string;
  selector?: string;
}): Promise<string> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserExtract requires `tabId`.');
  }
  const out = await rpc<string>('extract', {
    tabId: args.tabId,
    selector: args.selector,
  });
  // Defense-in-depth: extension also caps, but we re-cap on the
  // Node side using UTF-8 byte length sensibilities just in case
  // the extension's UTF-16 char count slipped past its cap.
  if (out.length > MAX_EXTRACT_CHARS) {
    return (
      out.slice(0, MAX_EXTRACT_CHARS) +
      `\n\n[truncated by Electron-side cap: ${out.length.toLocaleString()} chars; ` +
      `kept first ${MAX_EXTRACT_CHARS.toLocaleString()}]`
    );
  }
  return out;
}

/**
 * Single labelled element returned alongside a screenshot. The
 * extension assigns sequential `label` numbers (1, 2, 3 …) by
 * top-to-bottom / left-to-right viewport position, so the label
 * in the label table matches the badge painted on the annotated
 * image. `selector` is a best-effort stable CSS path the model
 * can hand straight to `BrowserClick { selector }`; `text` is the
 * visible inner text (trimmed, capped). `aria` carries the
 * computed accessible name when text is empty (icon-only buttons).
 */
export interface ScreenshotLabel {
  label: number;
  tag: string;
  role?: string;
  text?: string;
  aria?: string;
  selector?: string;
  bbox: { x: number; y: number; w: number; h: number };
}

/**
 * Screenshot return type. We deliberately ship TWO images per
 * call: a clean one for the model to read text on, and an
 * annotated one for the model to pick targets on. The user
 * asked for both — overlays can occlude content, and a single
 * image either makes text-reading harder (annotated) or makes
 * "click which thing?" guesswork (clean). `pageInfo` carries
 * viewport / scroll metadata so the model knows whether more
 * content exists below the fold.
 */
export interface ScreenshotResult {
  cleanBase64: string;
  annotatedBase64: string;
  bytesClean: number;
  bytesAnnotated: number;
  labels: ScreenshotLabel[];
  pageInfo: {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    fullSize: { width: number; height: number };
    devicePixelRatio: number;
  };
}

export async function screenshotTab(args: {
  tabId: string;
  area?: 'viewport' | 'fullPage';
  annotate?: boolean;
}): Promise<ScreenshotResult> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserScreenshot requires `tabId`.');
  }
  // Screenshot has to briefly activate the target tab (chrome.tabs.
  // captureVisibleTab only sees the active tab). That's a focus
  // hijack from the user's POV — gated behind authorization.
  _assertAuthorized(args.tabId, 'screenshot');
  return await rpc<ScreenshotResult>(
    'screenshot',
    {
      tabId: args.tabId,
      area: args.area === 'fullPage' ? 'fullPage' : 'viewport',
      annotate: args.annotate !== false,
    },
    // Bridge backstop — the SW finishes in <10 s typical and
    // ~25 s worst case (bounded by the new short captureVisibleTab
    // retry budget + 8 s SoM inject + 3 s pageInfo + ~1 s CDP
    // fallback per shot, doubled for annotated). We pad to 30 s so
    // the bridge timeout fires AFTER the SW gives up, not
    // mid-operation — that way the agent sees the SW's specific
    // error message ("GPU readback persistently blocked", etc.)
    // instead of a generic bridge timeout. If you ever see the
    // bridge timeout fire, the SW is genuinely stuck and the
    // 30 → 60 s extension wouldn't have saved it.
    30_000
  );
}

export async function waitForTab(args: {
  tabId: string;
  selector?: string;
  text?: string;
  networkIdle?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserWaitFor requires `tabId`.');
  }
  if (!args.selector && !args.text && !args.networkIdle) {
    throw new Error(
      'Chrome connector: BrowserWaitFor needs at least one of selector / text / networkIdle.'
    );
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await rpc<void>(
    'waitFor',
    {
      tabId: args.tabId,
      selector: args.selector,
      text: args.text,
      networkIdle: args.networkIdle,
      timeoutMs,
    },
    // Give the RPC a bit more time than the in-extension wait so the
    // extension can tell us about its own timeout, not the wire one.
    timeoutMs + 5_000
  );
}

// =====================================================================
// Write path
// =====================================================================

export async function clickTab(args: {
  tabId: string;
  selector?: string;
  text?: string;
  timeoutMs?: number;
  /**
   * Opt-in escape hatch for stubborn pages (Outlook search,
   * Shadow-DOM-wrapped inputs, sites that gate on event.isTrusted).
   * When true, the extension attaches `chrome.debugger` and dispatches
   * a real OS-level click via CDP `Input.dispatchMouseEvent`. Chrome
   * shows a yellow "started debugging this browser" infobar while the
   * session is attached. Default false.
   */
  useDebugger?: boolean;
}): Promise<void> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserClick requires `tabId`.');
  }
  if (!args.selector && !args.text) {
    throw new Error('Chrome connector: BrowserClick needs selector or text.');
  }
  _assertAuthorized(args.tabId, 'click');
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await rpc<void>(
    'click',
    {
      tabId: args.tabId,
      selector: args.selector,
      text: args.text,
      timeoutMs,
      useDebugger: !!args.useDebugger,
    },
    timeoutMs + 5_000
  );
}

export async function typeTab(args: {
  tabId: string;
  selector?: string;
  text: string;
  clearFirst?: boolean;
  timeoutMs?: number;
  /** See `clickTab.useDebugger`. */
  useDebugger?: boolean;
}): Promise<void> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserType requires `tabId`.');
  }
  if (typeof args.text !== 'string') {
    throw new Error('Chrome connector: BrowserType requires `text` (string).');
  }
  _assertAuthorized(args.tabId, 'type');
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  await rpc<void>(
    'type',
    {
      tabId: args.tabId,
      selector: args.selector,
      text: args.text,
      clearFirst: !!args.clearFirst,
      timeoutMs,
      useDebugger: !!args.useDebugger,
    },
    timeoutMs + 5_000
  );
}

export async function pressTab(args: {
  tabId: string;
  key: string;
  /** See `clickTab.useDebugger`. */
  useDebugger?: boolean;
}): Promise<void> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserPress requires `tabId`.');
  }
  if (!args.key) {
    throw new Error('Chrome connector: BrowserPress requires `key`.');
  }
  _assertAuthorized(args.tabId, 'press keys');
  await rpc<void>('press', {
    tabId: args.tabId,
    key: args.key,
    useDebugger: !!args.useDebugger,
  });
}

export async function scrollTab(args: {
  tabId: string;
  deltaY?: number;
  toY?: number;
}): Promise<void> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserScroll requires `tabId`.');
  }
  _assertAuthorized(args.tabId, 'scroll');
  await rpc<void>('scroll', {
    tabId: args.tabId,
    deltaY: typeof args.deltaY === 'number' ? args.deltaY : undefined,
    toY: typeof args.toY === 'number' ? args.toY : undefined,
  });
}

export async function evalTab(args: {
  tabId: string;
  expression: string;
  timeoutMs?: number;
}): Promise<string> {
  if (!args || typeof args.tabId !== 'string') {
    throw new Error('Chrome connector: BrowserEval requires `tabId`.');
  }
  if (!args.expression) {
    throw new Error('Chrome connector: BrowserEval requires `expression`.');
  }
  _assertAuthorized(args.tabId, 'evaluate JS');
  return await rpc<string>(
    'eval',
    {
      tabId: args.tabId,
      expression: args.expression,
    },
    args.timeoutMs ?? RPC_DEFAULT_TIMEOUT_MS
  );
}
