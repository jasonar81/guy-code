// One-shot fix for the doubled backslashes that crept into
// ~/.guycode/mcp.json after a PowerShell+node-eval quoting mismatch.
// Replaces any "\\X" inside mcp.json command paths with the correct
// single-backslash form. Idempotent — re-running on a clean file is a
// no-op.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const MCP = join(homedir(), '.guycode', 'mcp.json');

const j = JSON.parse(readFileSync(MCP, 'utf8'));

// Walk every server's `command` and normalise the path. JSON's
// in-memory representation uses single backslashes; if a previous edit
// wrote them as `\\` (two literal backslashes), the parsed value
// contains `\\` and won't resolve. Collapse runs of 2+ backslashes
// down to a single backslash for command paths only — env values and
// URLs are left alone.
let changed = false;
for (const [name, spec] of Object.entries(j.mcpServers ?? {})) {
  if (typeof spec?.command === 'string' && /\\\\/.test(spec.command)) {
    const before = spec.command;
    spec.command = spec.command.replace(/\\{2,}/g, '\\');
    console.log(`fixed ${name}.command:`);
    console.log(`  before: ${before}`);
    console.log(`  after:  ${spec.command}`);
    changed = true;
  }
}

if (changed) {
  writeFileSync(MCP, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  console.log('rewrote', MCP);
} else {
  console.log('no doubled paths found; nothing to do');
}
