// Installs the Atlassian MCP servers into ~/.guycode/mcp.json from the
// bootstrap file fetched off net1.
//
// Sets up TWO servers:
//   1. atlassian          — community stdio server (sooperset/mcp-atlassian
//                           via uvx). Uses the API token directly. Works
//                           immediately, no browser sign-in. Read+write
//                           Jira and Confluence.
//   2. atlassian-remote   — Anthropic's Atlassian Remote MCP at
//                           https://mcp.atlassian.com/v1/sse. OAuth-based,
//                           so requires a browser sign-in (same flow as
//                           Slack), but no API token. Configured here so
//                           the user can opt into it later from the
//                           Settings UI without editing files.
//
// Reads the per-line key=value bootstrap (JIRA_BASE_URL, JIRA_EMAIL,
// JIRA_API_TOKEN, JIRA_PROJECT_KEY) from ~/.guycode/atlassian-bootstrap.txt,
// merges the new server configs into any existing mcp.json (preserving
// disabledServers / enabledPlugins / autoEnableAllPlugins / other servers),
// and deletes the plaintext bootstrap once mcp.json has been written.
//
// Idempotent: re-running rotates the token in-place if the bootstrap file
// is repopulated, but won't clobber other servers the user added by hand.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';

const GUYCODE_DIR = join(homedir(), '.guycode');
const BOOTSTRAP = join(GUYCODE_DIR, 'atlassian-bootstrap.txt');
const MCP_JSON = join(GUYCODE_DIR, 'mcp.json');

if (!existsSync(BOOTSTRAP)) {
  console.error(`bootstrap not found at ${BOOTSTRAP}`);
  console.error('Run the net1 fetch step first.');
  process.exit(1);
}

// Parse KEY=value lines from the bootstrap. Tolerate trailing CR (the file
// was scp'd from Linux, but a previous run might have rewritten it on
// Windows).
const env = {};
for (const rawLine of readFileSync(BOOTSTRAP, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  const k = line.slice(0, eq).trim();
  let v = line.slice(eq + 1).trim();
  // Strip optional surrounding quotes — perf-agent's .env doesn't use
  // them, but the format allows it.
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  env[k] = v;
}

const required = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
for (const k of required) {
  if (!env[k]) {
    console.error(`bootstrap is missing ${k}`);
    process.exit(1);
  }
}

// For Atlassian Cloud, Confluence lives under /wiki on the same domain
// and uses the same token — derive both URL and credentials from the Jira
// values rather than asking for them separately. If the user later moves
// to a self-hosted Confluence on a different domain, they can edit
// mcp.json directly.
const JIRA_URL = env.JIRA_BASE_URL.replace(/\/+$/, ''); // strip trailing /
const CONFLUENCE_URL = `${JIRA_URL}/wiki`;

// Load any existing mcp.json so we don't blow away other servers.
let existing = { mcpServers: {} };
if (existsSync(MCP_JSON)) {
  try {
    existing = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
    if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
      existing.mcpServers = {};
    }
  } catch (e) {
    console.error(`existing mcp.json is unreadable; refusing to overwrite: ${e.message}`);
    console.error('Move it aside manually and re-run.');
    process.exit(1);
  }
}

// Locate uvx. The user installed `uv` via `pip install --user`, which
// drops uvx into the per-user Roaming Python Scripts dir on Windows —
// that's not on PATH by default. Probe a few likely locations and fall
// back to the bare command name (which Electron will resolve via the
// inherited PATH at spawn time, in case the user has their own uvx).
function findUvx() {
  const isWin = platform() === 'win32';
  const candidates = [];
  // PATH first — `where` (Windows) / `which` (Unix). If present, just
  // use the bare command name and let the OS resolve.
  try {
    const cmd = isWin ? 'where uvx' : 'command -v uvx';
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) {
      // PATH-resolvable — return the bare name so the config stays
      // portable across machines.
      return { command: 'uvx', args: ['mcp-atlassian'] };
    }
  } catch {
    /* not on PATH */
  }
  // Per-user pip install locations (Windows). Walk common Python
  // versions; whichever exists wins.
  if (isWin) {
    const appdata = process.env.APPDATA;
    if (appdata) {
      for (const ver of ['Python313', 'Python312', 'Python311', 'Python310', 'Python39']) {
        candidates.push(join(appdata, 'Python', ver, 'Scripts', 'uvx.exe'));
      }
    }
  } else {
    candidates.push(join(homedir(), '.local', 'bin', 'uvx'));
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      return { command: c, args: ['mcp-atlassian'] };
    }
  }
  // Last-ditch fallback — let Electron's spawn try the bare name.
  // mcp.ts will surface a "command not found" error in the UI which
  // gives the user a clear next step.
  console.warn('uvx not found in PATH or any common --user install location.');
  console.warn('Falling back to bare `uvx` — install uv via `pip install --user uv`');
  console.warn('and restart Guy Code if the atlassian server fails to start.');
  return { command: 'uvx', args: ['mcp-atlassian'] };
}

const uvx = findUvx();

// 1. Community stdio server — works immediately with the existing token.
existing.mcpServers.atlassian = {
  command: uvx.command,
  args: uvx.args,
  env: {
    JIRA_URL,
    JIRA_USERNAME: env.JIRA_EMAIL,
    JIRA_API_TOKEN: env.JIRA_API_TOKEN,
    CONFLUENCE_URL,
    CONFLUENCE_USERNAME: env.JIRA_EMAIL,
    CONFLUENCE_API_TOKEN: env.JIRA_API_TOKEN,
    ...(env.JIRA_PROJECT_KEY ? { JIRA_PROJECTS_FILTER: env.JIRA_PROJECT_KEY } : {}),
  },
};

// 2. Anthropic Atlassian Remote (OAuth fallback). DCR — no static client
// ID. Scope set lifts the read-only default to read+write so the user
// gets the same capabilities as the community server.
//
// callbackPort 3119 to avoid colliding with Slack's 3118.
existing.mcpServers['atlassian-remote'] = {
  type: 'sse',
  url: 'https://mcp.atlassian.com/v1/sse',
  oauth: {
    callbackPort: 3119,
    scope: [
      'read:jira-work',
      'write:jira-work',
      'read:confluence-content.all',
      'write:confluence-content',
      'write:confluence-space',
      'offline_access',
    ].join(' '),
  },
};

// Default-disable the OAuth fallback so it doesn't auto-attempt to
// connect (and noise up status indicators) while the stdio server is
// healthy. The user opts it in from Settings → MCP when they want to
// switch.
const disabled = new Set(Array.isArray(existing.disabledServers) ? existing.disabledServers : []);
disabled.add('atlassian-remote');
existing.disabledServers = [...disabled];

mkdirSync(GUYCODE_DIR, { recursive: true });
writeFileSync(MCP_JSON, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
console.log(`wrote ${MCP_JSON}`);

// Wipe the plaintext bootstrap. The token now lives only inside mcp.json
// (which we just chmod'd to 0600 on systems that honour it).
try {
  unlinkSync(BOOTSTRAP);
  console.log(`removed ${BOOTSTRAP}`);
} catch (e) {
  console.warn(`could not remove ${BOOTSTRAP}: ${e.message}`);
}

console.log('');
console.log('Atlassian MCP installed:');
console.log('  atlassian          — community stdio (primary, enabled)');
console.log('  atlassian-remote   — Anthropic OAuth (fallback, disabled by default)');
console.log('');
console.log('Restart Guy Code. The community server connects automatically;');
console.log('the OAuth one is opt-in via Settings → MCP.');
