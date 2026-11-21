/**
 * Claude Code hooks for a2a-peer (design 7.4):
 *   node ${CLAUDE_PLUGIN_ROOT}/dist/hook.js <SessionStart|UserPromptSubmit|Stop|SessionEnd>
 *
 * The hook path is MANDATORY, not a fallback nicety (design 12a): channels
 * may be off for the org, off for this session, or blocked by the allowlist,
 * and in every one of those cases Claude Code drops channel events silently.
 * UserPromptSubmit is the one delivery Claude Code guarantees reaches the
 * model, so every inbox item not yet acked for this session is injected here
 * as `additionalContext` (the same envelope) and acked. Items the channel
 * already pushed are injected again if nothing acked them, which is exactly
 * the at-least-once rule.
 *
 * Fail open, always: a dead or slow daemon must never block the user's
 * prompt. Any error prints `{}` and exits 0. The whole run is bounded to
 * about 2 s (design 7.4); SessionStart may first start the daemon (3 s).
 *
 * Reads the hook JSON from stdin, forwards it to the daemon's local API with
 * Claude Code's pid (our parent) for MCP session correlation, and prints the
 * daemon's answer, which is already in Claude Code's hook output shape.
 */
import { join } from 'node:path';
import { connectDaemon, ensureDaemon } from './shared/local';
import { dataDir } from './shared/paths';
import { isEntry } from './shared/entry';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks: Buffer[] = [];
    const t = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), timeoutMs);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      resolve('');
    });
  });
}

/** Run one hook; resolves to the JSON object to print. Never rejects. */
export async function runHook(event: string, stdinText: string, env: NodeJS.ProcessEnv = process.env, ccPid: number = process.ppid): Promise<Record<string, unknown>> {
  try {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) return {};
    let input: Record<string, unknown> = {};
    try {
      input = stdinText ? JSON.parse(stdinText) : {};
    } catch {
      return {};
    }
    const dir = dataDir(env);
    const client =
      event === 'SessionStart'
        ? await ensureDaemon({ dataDir: dir, daemonScript: join(__dirname, 'daemon.js'), env, waitMs: 3000 })
        : await connectDaemon(dir, 700);
    if (!client) return {};
    const out = await client.request<Record<string, unknown>>('POST', `/local/hook/${event}`, { ...input, cc_pid: ccPid }, 1500);
    return out && typeof out === 'object' ? out : {};
  } catch {
    return {};
  }
}

export async function main(): Promise<void> {
  const event = String(process.argv[2] ?? '');
  const stdinText = await readStdin(500);
  const out = await runHook(event, stdinText);
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (isEntry('hook')) {
  // Hard stop: whatever happens, never hold the user's prompt hostage.
  setTimeout(() => {
    process.stdout.write('{}');
    process.exit(0);
  }, 4500).unref();
  void main();
}
