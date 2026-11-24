/**
 * The a2a-peer MCP server AND Claude Code channel (design 7.3, 12a).
 *
 * One process per Claude Code session (Claude Code starts it over stdio from
 * .mcp.json). It:
 *   - declares `capabilities: { tools: {}, experimental: { "claude/channel": {} } }`
 *     and NOT `claude/channel/permission`: a peer must never be able to answer
 *     this user's tool-permission prompts (design 4.2.8);
 *   - hands Claude the `instructions` string on connect (shared/meta.ts);
 *   - serves the nine a2a_* tools by forwarding them to the daemon's local API;
 *   - subscribes to the daemon's SSE stream for its session and turns each
 *     inbox item into `notifications/claude/channel { content, meta }`.
 *
 * Channels are an ENHANCEMENT. Claude Code does not acknowledge channel
 * notifications and silently drops them when channels are off (Team /
 * Enterprise until an Owner enables them, any session not started with
 * --channels / --dangerously-load-development-channels, any plugin not on the
 * allowlist). So emitting here never marks anything as seen; the item stays
 * unacked until a tool references it or the UserPromptSubmit hook injects it.
 *
 * Meta keys go through `channelMeta`, which normalises every key to
 * [A-Za-z0-9_]: a hyphenated key would be dropped by Claude Code without a
 * word.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { join } from 'node:path';
import { CHANNEL_INSTRUCTIONS, channelMeta } from './shared/meta';
import { ensureDaemon, type LocalClient } from './shared/local';
import { isEntry } from './shared/entry';
import { MCP_TOOLS } from './tools';
import { PLUGIN_VERSION, dataDir } from './shared/paths';

export const CHANNEL_METHOD = 'notifications/claude/channel';

/** What the MCP server needs from the daemon. The real one is HTTP; tests pass a core-backed one. */
export interface McpBackend {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface A2AMcp {
  server: Server;
  /** Emit one channel event. Meta is normalised first. Never throws. */
  emit(content: string, meta: Record<string, unknown>): Promise<boolean>;
  connect(transport: Transport): Promise<void>;
}

export const SERVER_CAPABILITIES = { tools: {}, experimental: { 'claude/channel': {} } } as const;

export function createA2AMcp(backend: McpBackend): A2AMcp {
  const server = new Server({ name: 'a2a', version: PLUGIN_VERSION }, { capabilities: { ...SERVER_CAPABILITIES }, instructions: CHANNEL_INSTRUCTIONS });
  const names = new Set(MCP_TOOLS.map((t) => t.name));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (!names.has(name)) return { content: [{ type: 'text', text: `error: unknown tool ${name}` }], isError: true };
    try {
      const text = await backend.callTool(name, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text }], isError: text.startsWith('error:') };
    } catch (e) {
      // The daemon is down or slow: say so, plainly, instead of hanging.
      return { content: [{ type: 'text', text: `error: the a2a-peer daemon did not answer (${(e as Error).message}). Try /a2a-peer:status.` }], isError: true };
    }
  });
  return {
    server,
    async emit(content, meta) {
      try {
        // A custom Claude Code notification: the SDK's typed union does not
        // know it, so it goes through the untyped door.
        await (server as unknown as { notification(n: { method: string; params: unknown }): Promise<void> }).notification({
          method: CHANNEL_METHOD,
          params: { content: String(content ?? ''), meta: channelMeta(meta ?? {}) },
        });
        return true;
      } catch {
        return false;
      }
    },
    connect: (t) => server.connect(t),
  };
}

/** HTTP backend: forward a tool call to the daemon's local API. */
function httpBackend(getClient: () => LocalClient | null, conn: () => string | null): McpBackend {
  return {
    async callTool(name, args) {
      const c = getClient();
      if (!c) throw new Error('daemon not running');
      // a2a_wait may block up to 10 minutes inside the daemon.
      // a2a_room join waits up to ~30 s for the inviter's admit (connect + JOIN_WAIT_MS).
      const timeout = name === 'a2a_wait' || name === 'a2a_wait_any' ? 11 * 60_000 : name === 'a2a_room' ? 60_000 : 20_000;
      const r = await c.request<{ text: string }>('POST', `/local/tool/${name}`, { args, conn: conn(), cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd() }, timeout);
      return r.text;
    },
  };
}

export async function main(): Promise<void> {
  const dir = dataDir();
  const daemonScript = join(__dirname, 'daemon.js');
  let client: LocalClient | null = null;
  let conn: string | null = null;
  const mcp = createA2AMcp(httpBackend(() => client, () => conn));
  await mcp.connect(new StdioServerTransport());

  let closeStream: (() => void) | null = null;
  let backoff = 500;
  const subscribe = async (): Promise<void> => {
    client = await ensureDaemon({ dataDir: dir, daemonScript });
    if (!client) return void setTimeout(subscribe, (backoff = Math.min(backoff * 2, 30_000))).unref?.();
    try {
      // Correlate with the SessionStart registration (design Q2): our parent
      // is Claude Code, and so is the hook's.
      const r = await client.request<{ conn: string; session_id: string | null }>('POST', '/local/register', {
        cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
        cc_pid: process.ppid,
      });
      conn = r.conn;
      backoff = 500;
      closeStream = client.events(
        r.conn,
        (event, data) => {
          const d = data as { content?: string; meta?: Record<string, unknown> };
          if (typeof d?.content === 'string') void mcp.emit(d.content, d.meta ?? {});
        },
        () => {
          closeStream = null;
          setTimeout(subscribe, (backoff = Math.min(backoff * 2, 30_000))).unref?.();
        }
      );
    } catch {
      setTimeout(subscribe, (backoff = Math.min(backoff * 2, 30_000))).unref?.();
    }
  };
  await subscribe();
  process.stdin.on('close', () => {
    closeStream?.();
    process.exit(0);
  });
}

if (isEntry('mcp')) {
  main().catch((e) => {
    process.stderr.write(`a2a-peer MCP server failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
