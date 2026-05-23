// MCP (Model Context Protocol) client glue.
//
// We discover MCP server configs from three places, merged in this priority:
//   1. ~/.guycode/mcp.json       → mcpServers + disabledServers
//   2. ~/.claude.json            → mcpServers (top-level + per-project)
//   3. ~/.claude/plugins/marketplaces/*/external_plugins/*/.mcp.json
//      (auto-discovered marketplace plugins — slack, github, etc.)
//
// Each server can be one of two transports:
//   • stdio: spawn a local subprocess (most plugins)
//   • http:  connect to an HTTP/SSE endpoint, optionally via OAuth
//
// At startup we:
//   • connect each (enabled, non-disabled) server in parallel
//   • call `tools/list` to discover what they offer
//   • register a wrapper tool with name `mcp__<server>__<tool>`
//
// Tool invocations from the LLM are routed by splitting on `__`. Connections
// stay alive for the lifetime of the app. Servers that need OAuth and have
// no saved tokens are kept in `needsAuth` status; the renderer can trigger
// signIn(serverName) to start the browser flow.
//
// A failing server is logged loudly but never blocks the rest.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import log from 'electron-log';
import type Anthropic from '@anthropic-ai/sdk';
import { app } from 'electron';
import { GuyOAuthProvider, getPendingAuthCode } from './mcpOAuth';

interface StdioServerSpec {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface HttpServerSpec {
  type: 'http' | 'sse';
  url: string;
  oauth?: {
    clientId?: string;
    callbackPort: number;
    /**
     * Space-separated OAuth scopes to request. Overrides whatever the
     * server advertises in resource metadata. Use this when a server
     * exposes write capabilities but the default scope set is
     * read-only (e.g. Atlassian's MCP — the default discovery flow
     * gives read-only access to Jira/Confluence; you need to
     * explicitly request write scopes here).
     *
     * Example for Atlassian Confluence+Jira write access:
     *   "read:jira-work write:jira-work
     *    read:confluence-content.all write:confluence-content
     *    write:confluence-space offline_access"
     *
     * After changing this, you must clear the saved tokens for this
     * server (Settings → MCP → Sign Out & Re-sign In) so the next
     * sign-in requests the new scope set.
     */
    scope?: string;
    /**
     * Hostname to use when building the local OAuth callback URL
     * (`http://<redirectHost>:<callbackPort>/callback`). Defaults to
     * `localhost` because that is the value most OAuth providers
     * register for native-app loopback flows. Set to `127.0.0.1` if
     * a provider's app registration only lists the literal IPv4
     * loopback address — Slack rejected our `127.0.0.1`-form URI on
     * the shared Anthropic client ID, since that ID is registered
     * with the `localhost`-form URI in Slack's OAuth app config.
     *
     * The local HTTP listener itself stays bound to `127.0.0.1` for
     * security regardless of this value; on Windows + macOS + Linux
     * the OS resolves `localhost` to `127.0.0.1` (IPv4 preferred), so
     * the browser still reaches the listener.
     */
    redirectHost?: string;
  };
  headers?: Record<string, string>;
}

type ServerSpec = StdioServerSpec | HttpServerSpec;

export type McpStatus = 'connected' | 'needs-auth' | 'error' | 'disabled' | 'connecting';

interface ServerState {
  name: string;
  spec: ServerSpec;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport;
  oauthProvider?: GuyOAuthProvider;
  tools: { name: string; description?: string; inputSchema: any }[];
  status: McpStatus;
  error?: string;
  /** Where we found this config (for debugging / UI). */
  source: string;
}

const _servers = new Map<string, ServerState>();
let _initialized = false;

function configPaths(): string[] {
  // Search order matters — first config to define a server wins. Guy-local
  // overrides Claude defaults so the user can swap scope / disable a
  // server per-app without editing their shared Claude config.
  //
  // Locations:
  //   1. ~/.guycode/mcp.json — Guy's primary config (top-priority).
  //   2. ~/.claude/mcp.json — newer Claude Code location (introduced
  //      around the Claude Code v1.x reshuffle; many users have their
  //      Atlassian / Notion / etc. configs here).
  //   3. ~/.claude/settings.json — Claude Code user settings (sometimes
  //      carries an `mcpServers` field for global servers).
  //   4. ~/.claude.json — legacy Claude Code config; top-level mcpServers
  //      plus a `projects.<encoded-cwd>.mcpServers` map for per-project
  //      servers. We parse BOTH top-level and the project nested maps so
  //      a server configured for any project gets surfaced to Guy.
  return [
    join(homedir(), '.guycode', 'mcp.json'),
    join(homedir(), '.claude', 'mcp.json'),
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude.json'),
  ];
}

interface DiscoveredConfig {
  spec: ServerSpec;
  source: string;
}

/** Walk the Claude Code marketplace plugins directory for installed plugins. */
function discoverMarketplacePlugins(): Record<string, DiscoveredConfig> {
  const root = join(homedir(), '.claude', 'plugins', 'marketplaces');
  const out: Record<string, DiscoveredConfig> = {};
  if (!existsSync(root)) return out;
  let marketplaces: string[] = [];
  try {
    marketplaces = readdirSync(root);
  } catch {
    return out;
  }
  for (const m of marketplaces) {
    const pluginsDir = join(root, m, 'external_plugins');
    if (!existsSync(pluginsDir)) continue;
    let plugins: string[] = [];
    try {
      plugins = readdirSync(pluginsDir);
    } catch {
      continue;
    }
    for (const p of plugins) {
      const mcpFile = join(pluginsDir, p, '.mcp.json');
      if (!existsSync(mcpFile)) continue;
      try {
        const st = statSync(mcpFile);
        if (!st.isFile()) continue;
        const raw = JSON.parse(readFileSync(mcpFile, 'utf8'));
        // Plugin `.mcp.json` shape is { <serverName>: <spec>, ... } — usually
        // just one server per plugin, but support multi.
        for (const [name, spec] of Object.entries(raw ?? {})) {
          if (!spec || typeof spec !== 'object') continue;
          if (out[name]) continue; // first-seen wins
          out[name] = { spec: spec as ServerSpec, source: `plugin:${m}/${p}` };
        }
      } catch (e) {
        log.warn(`[mcp] failed to parse ${mcpFile}`, e);
      }
    }
  }
  return out;
}

function loadConfigs(): {
  servers: Record<string, DiscoveredConfig>;
  disabled: Set<string>;
  autoEnableAllPlugins: boolean;
  enabledPlugins: Set<string>;
} {
  const servers: Record<string, DiscoveredConfig> = {};
  const disabled = new Set<string>();
  let autoEnableAllPlugins = false;
  const enabledPlugins = new Set<string>();

  for (const p of configPaths()) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      const ms = raw?.mcpServers;
      if (ms && typeof ms === 'object') {
        for (const [name, spec] of Object.entries(ms)) {
          if (!spec || typeof spec !== 'object') continue;
          if (servers[name]) continue;
          servers[name] = { spec: spec as ServerSpec, source: p };
        }
      }
      // Claude Code's ~/.claude.json stores per-project MCP servers
      // under `projects.<encoded-cwd>.mcpServers`. Walk every project
      // entry and merge any servers found. This is where users
      // typically configure Atlassian MCP (and other remote OAuth
      // servers) — Claude Code's `claude mcp add --scope=project`
      // writes to this section. Without this branch Guy never sees
      // those servers, which is the root cause of the "no Atlassian
      // MCP capabilities" report.
      const projects = raw?.projects;
      if (projects && typeof projects === 'object') {
        for (const [projKey, projVal] of Object.entries(projects)) {
          if (!projVal || typeof projVal !== 'object') continue;
          const pms = (projVal as Record<string, unknown>).mcpServers;
          if (!pms || typeof pms !== 'object') continue;
          for (const [name, spec] of Object.entries(
            pms as Record<string, unknown>
          )) {
            if (!spec || typeof spec !== 'object') continue;
            if (servers[name]) continue; // first-seen wins (file order)
            servers[name] = {
              spec: spec as ServerSpec,
              source: `${p}#projects.${projKey}`,
            };
          }
        }
      }
      // Guy-specific: explicit disable list and plugin enable list.
      if (Array.isArray(raw?.disabledServers)) {
        for (const n of raw.disabledServers) if (typeof n === 'string') disabled.add(n);
      }
      if (raw?.autoEnableAllPlugins === true) autoEnableAllPlugins = true;
      if (Array.isArray(raw?.enabledPlugins)) {
        for (const n of raw.enabledPlugins) if (typeof n === 'string') enabledPlugins.add(n);
      }
    } catch (e) {
      log.warn(`[mcp] failed to parse ${p}`, e);
    }
  }

  // Merge in marketplace plugins. HTTP/OAuth plugins are surfaced
  // unconditionally so the user sees them in Settings with "Sign in required"
  // — they consume zero resources until signed in. Stdio plugins still
  // require explicit enable since they spawn subprocesses immediately.
  const discovered = discoverMarketplacePlugins();
  for (const [name, cfg] of Object.entries(discovered)) {
    if (servers[name]) continue;
    const isHttpOAuth =
      (cfg.spec as HttpServerSpec).type === 'http' &&
      !!(cfg.spec as HttpServerSpec).oauth;
    if (!autoEnableAllPlugins && !enabledPlugins.has(name) && !isHttpOAuth) continue;
    servers[name] = cfg;
  }

  return { servers, disabled, autoEnableAllPlugins, enabledPlugins };
}

export async function initMcp(): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  const { servers, disabled } = loadConfigs();
  const names = Object.keys(servers);
  if (names.length === 0) {
    log.info('[mcp] no MCP servers configured');
    return;
  }
  log.info(`[mcp] connecting to ${names.length} server(s): ${names.join(', ')}`);

  await Promise.all(
    names.map(async (name) => {
      const { spec, source } = servers[name];
      const state: ServerState = {
        name,
        spec,
        tools: [],
        status: 'connecting',
        source,
      };
      _servers.set(name, state);
      if (disabled.has(name)) {
        state.status = 'disabled';
        log.info(`[mcp] "${name}" disabled by config (${source})`);
        return;
      }
      try {
        await connectOne(state);
      } catch (e: any) {
        if (e instanceof UnauthorizedError) {
          state.status = 'needs-auth';
          state.error = 'OAuth sign-in required';
          log.info(`[mcp] "${name}" needs sign-in`);
          return;
        }
        state.status = 'error';
        state.error = e?.message ?? String(e);
        log.error(`[mcp] server "${name}" failed to start`, e);
      }
    })
  );
}

async function connectOne(state: ServerState): Promise<void> {
  const { name, spec } = state;
  state.status = 'connecting';
  state.error = undefined;

  const client = new Client(
    { name: 'guy-code', version: app.getVersion() },
    { capabilities: {} }
  );
  state.client = client;

  if (isHttpSpec(spec)) {
    const url = new URL(spec.url);
    let authProvider: GuyOAuthProvider | undefined;
    if (spec.oauth) {
      // Reuse the existing provider if we have one. This is critical for
      // sign-in: signInMcp() calls state.oauthProvider.setInteractive(true)
      // BEFORE calling connectOne. If we overwrote the provider here with
      // a fresh instance (which defaults to non-interactive), the SDK's
      // auth flow would land in the new provider's redirectToAuthorization,
      // see _interactive=false, and return without starting the local
      // callback listener — so getPendingAuthCode then throws
      // "No pending OAuth callback for <name> — flow not started?", which
      // is exactly the error the user saw on the Slack sign-in attempt.
      // The provider only depends on spec fields (server name, clientId,
      // callbackPort, scope), all of which are stable for a given server,
      // so reusing across reconnects is safe.
      authProvider =
        state.oauthProvider ??
        new GuyOAuthProvider({
          serverName: name,
          staticClientId: spec.oauth.clientId,
          callbackPort: spec.oauth.callbackPort,
          scope: spec.oauth.scope,
          redirectHost: spec.oauth.redirectHost,
        });
      state.oauthProvider = authProvider;
    }
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: spec.headers ? { headers: spec.headers } : undefined,
    });
    state.transport = transport;
    await client.connect(transport);
  } else {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
      cwd: spec.cwd,
    });
    state.transport = transport;
    await client.connect(transport);
  }

  const listed = await client.listTools();
  state.tools = (listed.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
  state.status = 'connected';
  log.info(`[mcp] "${name}" connected — ${state.tools.length} tools`);
}

function isHttpSpec(spec: ServerSpec): spec is HttpServerSpec {
  return (spec as HttpServerSpec).type === 'http' || (spec as HttpServerSpec).type === 'sse';
}

/**
 * Kick off the OAuth flow for a server that's in `needs-auth` state. Returns
 * once the user has completed sign-in and the server has reconnected.
 */
export async function signInMcp(name: string): Promise<{ ok: boolean; error?: string }> {
  const state = _servers.get(name);
  if (!state) return { ok: false, error: `unknown server: ${name}` };
  if (!isHttpSpec(state.spec) || !state.spec.oauth) {
    return { ok: false, error: `server "${name}" is not an OAuth HTTP server` };
  }
  try {
    // The first connectOne in initMcp() ran in silent mode (no browser pop).
    // Switch the provider into interactive mode for this attempt so
    // redirectToAuthorization actually opens the browser.
    state.oauthProvider?.setInteractive(true);
    try {
      // First attempt: the SDK's start() triggers redirectToAuthorization,
      // which opens the browser and starts our local listener. The SDK then
      // throws UnauthorizedError — we catch, wait for the code, finishAuth,
      // and reconnect.
      try {
        await connectOne(state);
        // If this returned without UnauthorizedError, we were already authed.
        return { ok: true };
      } catch (e: any) {
        if (!(e instanceof UnauthorizedError)) throw e;
      }
      log.info(`[mcp] "${name}" awaiting browser callback...`);
      const code = await getPendingAuthCode(name);
      const transport = state.transport as StreamableHTTPClientTransport | undefined;
      if (!transport) {
        return { ok: false, error: 'transport not initialized' };
      }
      await transport.finishAuth(code);
      // Replace the failed transport+client and connect fresh now that we have
      // tokens persisted via saveTokens().
      try {
        await state.client?.close();
      } catch {
        /* ignore */
      }
      await connectOne(state);
      return { ok: true };
    } finally {
      state.oauthProvider?.setInteractive(false);
    }
  } catch (e: any) {
    state.status = 'error';
    state.error = e?.message ?? String(e);
    log.error(`[mcp] sign-in for "${name}" failed`, e);
    return { ok: false, error: state.error };
  }
}

/** Snapshot of every known server for the Settings UI. */
export function listMcpServers(): {
  name: string;
  status: McpStatus;
  toolCount: number;
  error?: string;
  needsOAuth: boolean;
  source: string;
  /** Tool names exposed by this server (only meaningful when connected). */
  toolNames: string[];
  /** OAuth scopes the user configured in `.mcp.json`, if any. */
  configuredScope?: string;
}[] {
  return [..._servers.values()].map((s) => ({
    name: s.name,
    status: s.status,
    toolCount: s.tools.length,
    error: s.error,
    needsOAuth: isHttpSpec(s.spec) && !!s.spec.oauth,
    source: s.source,
    toolNames: s.tools.map((t) => t.name),
    configuredScope: isHttpSpec(s.spec) ? s.spec.oauth?.scope : undefined,
  }));
}

/**
 * Sign out of an MCP server — clear all persisted OAuth state for it
 * and disconnect the live client. The user can then call signInMcp to
 * re-auth, which is the standard flow for picking up a new scope set
 * after editing `.mcp.json`.
 *
 * Returns false if the server is unknown or non-OAuth.
 */
export async function signOutMcp(
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const state = _servers.get(name);
  if (!state) return { ok: false, error: `unknown server: ${name}` };
  if (!isHttpSpec(state.spec) || !state.spec.oauth || !state.oauthProvider) {
    return { ok: false, error: `server "${name}" is not an OAuth HTTP server` };
  }
  try {
    state.oauthProvider.signOut();
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
  // Close any live client/transport so subsequent calls don't reuse the
  // stale (and now-unauthenticated-from-the-server's-side) connection.
  try {
    await state.client?.close();
  } catch {
    /* ignore */
  }
  state.client = undefined;
  state.transport = undefined;
  state.tools = [];
  state.status = 'needs-auth';
  state.error = 'Signed out — sign in again to reconnect';
  log.info(`[mcp] "${name}" signed out`);
  return { ok: true };
}

/** Anthropic tool schemas for everything every CONNECTED MCP server exposes. */
export function getMcpToolSchemas(): Anthropic.Tool[] {
  const out: Anthropic.Tool[] = [];
  for (const [, srv] of _servers) {
    if (srv.status !== 'connected') continue;
    for (const t of srv.tools) {
      out.push({
        name: `mcp__${srv.name}__${t.name}`,
        description: t.description
          ? `[mcp:${srv.name}] ${t.description}`
          : `[mcp:${srv.name}] ${t.name}`,
        input_schema: t.inputSchema,
      });
    }
  }
  return out;
}

/**
 * If the tool name matches an MCP tool, invoke it on the right server and
 * return its text content. Returns null if the name isn't an MCP tool.
 */
export async function invokeMcpTool(
  toolName: string,
  input: unknown
): Promise<{ content: string; isError: boolean } | null> {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep < 0) return null;
  const serverName = rest.slice(0, sep);
  const realName = rest.slice(sep + 2);
  const srv = _servers.get(serverName);
  if (!srv) {
    return { content: `MCP server "${serverName}" not connected`, isError: true };
  }
  if (srv.status !== 'connected' || !srv.client) {
    return {
      content: `MCP server "${serverName}" not connected (${srv.status}${srv.error ? `: ${srv.error}` : ''})`,
      isError: true,
    };
  }
  try {
    const result = await srv.client.callTool({
      name: realName,
      arguments: (input ?? {}) as Record<string, unknown>,
    });
    // SDK types `result.content` as `{}` (lossy upstream), but at runtime
    // it's always an array of content blocks (text / image / etc.). Cast so
    // we can iterate without losing the rest of the call signature.
    const text = ((result.content as unknown[] | undefined) ?? [])
      .map((c: any) => {
        if (c?.type === 'text') return c.text;
        if (c?.type === 'image') return `[image: ${c.mimeType ?? 'unknown'}]`;
        return JSON.stringify(c);
      })
      .join('\n');
    return { content: text || '(no content)', isError: !!result.isError };
  } catch (e: any) {
    return { content: `MCP call failed: ${e?.message ?? String(e)}`, isError: true };
  }
}

export async function shutdownMcp(): Promise<void> {
  await Promise.all(
    [..._servers.values()].map(async (s) => {
      try {
        await s.client?.close();
      } catch {
        /* ignore */
      }
    })
  );
  _servers.clear();
  _initialized = false;
}
