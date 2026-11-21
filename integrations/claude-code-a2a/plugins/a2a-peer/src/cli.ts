/**
 * The plugin CLI behind the slash commands (design 7.5):
 *   node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js <peers|inbox|tasks|pair|unpair|trust|label|log|status> [args]
 *
 * Pairing and trust are commands, not MCP tools, on purpose: each slash
 * command tells Claude to run this CLI through Bash, so the user sees the
 * exact command in a permission prompt before anything changes. That makes
 * "/a2a-peer:trust dylan full" a deliberate act (design 4.2.3), and a peer's
 * message has no tool it could talk the model into calling quietly.
 *
 * The CLI finds the session it runs in by cwd (CLAUDE_PROJECT_DIR or the
 * working directory), which is how the trust route reads the user's own last
 * prompt for the escalation check. Output is plain text for Claude to show
 * verbatim. Pairing codes are printed for the human only, never logged.
 */
import { join } from 'node:path';
import { ensureDaemon } from './shared/local';
import { dataDir } from './shared/paths';
import { isEntry } from './shared/entry';

const USAGE = `usage: cli.js <command> [args]
  peers                         list paired peers
  inbox                         unread A2A items for this session
  tasks [in|out] [open]         A2A tasks
  pair [code]                   no code: print MY pairing code; with a code: pair with them
  unpair <peer>                 unpair and forget a peer
  trust <peer> <blocked|inform|collaborate|full> [for <duration>]
  label <text>                  name this session for peers (to_session)
  log [n]                       last n audit entries
  status                        daemon, endpoint, delivery mode`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const dir = dataDir();
  const client = await ensureDaemon({ dataDir: dir, daemonScript: join(__dirname, 'daemon.js'), waitMs: 4000 });
  if (!client) {
    process.stdout.write('The a2a-peer daemon is not running and could not be started. Check that node >= 20 is on PATH.\n');
    return 1;
  }
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const session = await client
    .request<{ conn: string; session_id: string | null }>('POST', '/local/register', { cwd, cc_pid: process.ppid, probe: true })
    .catch(() => ({ conn: '', session_id: null }));
  const base = { session_id: session.session_id, cwd };
  const tool = (name: string, args: Record<string, unknown>) => client.request<{ text: string }>('POST', `/local/tool/${name}`, { args, ...base }, 15_000);
  let r: { text: string };
  switch (cmd) {
    case 'peers':
      r = await tool('a2a_peers', {});
      break;
    case 'inbox':
      r = await tool('a2a_inbox', {});
      break;
    case 'tasks':
      r = await tool('a2a_tasks', { direction: rest.find((x) => x === 'in' || x === 'out'), open: rest.includes('open') });
      break;
    case 'pair':
      r = await client.request('POST', '/local/pair', { code: rest.join(' ').trim(), ...base }, 15_000);
      break;
    case 'unpair':
      r = await client.request('POST', '/local/pair', { action: 'revoke', peer: rest[0], ...base }, 10_000);
      break;
    case 'trust': {
      const [peer, level, maybeFor, dur] = rest;
      const expires_in = maybeFor === 'for' ? dur : maybeFor;
      r = await client.request('POST', '/local/trust', { peer, level, ...(expires_in ? { expires_in } : {}), ...base });
      break;
    }
    case 'label':
      r = await client.request('POST', '/local/label', { label: rest.join(' '), ...base });
      break;
    case 'log':
      r = await client.request('POST', '/local/log', { n: Number(rest[0]) || 30, ...base });
      break;
    case 'status':
      r = await client.request('POST', '/local/status', base);
      break;
    default:
      process.stdout.write(USAGE + '\n');
      return 2;
  }
  process.stdout.write(String(r?.text ?? '') + '\n');
  return String(r?.text ?? '').startsWith('error:') ? 1 : 0;
}

if (isEntry('cli')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stdout.write(`error: ${(e as Error).message}\n`);
      process.exit(1);
    }
  );
}
