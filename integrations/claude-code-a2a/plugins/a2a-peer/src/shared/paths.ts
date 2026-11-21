/**
 * Where the plugin keeps its state, and its version. Tiny on purpose: the
 * hook and MCP bundles import this without dragging in the daemon (sql.js,
 * the A2A server) - the hook runs on every prompt and must start fast.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PLUGIN_VERSION = '0.1.0';

/**
 * ${CLAUDE_PLUGIN_DATA} (Claude Code exports it to hooks and stdio MCP
 * servers), else the same directory Claude Code would use for
 * a2a-peer@ocient-agents, so the CLI run by hand finds the same daemon.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.CLAUDE_PLUGIN_DATA || join(env.HOME || env.USERPROFILE || '.', '.claude', 'plugins', 'data', 'a2a-peer-ocient-agents');
  mkdirSync(d, { recursive: true });
  return d;
}
