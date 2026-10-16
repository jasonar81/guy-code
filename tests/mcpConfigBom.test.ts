/**
 * A byte-order mark must not wipe out the MCP server list.
 *
 * Windows PowerShell 5.1 writes a UTF-8 BOM with `Set-Content -Encoding UTF8`.
 * JSON.parse rejects it, and the loader skips the whole file on a parse
 * error - so a single hand edit of ~/.guycode/mcp.json silently removed every
 * server it defined (atlassian, slack, ...) on the next start. This happened
 * for real on 2026-10-16 while restoring the Slack server.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron-log', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0' }, safeStorage: {} }));

const CONFIG = {
  mcpServers: {
    atlassian: { command: 'mcp-atlassian.exe', args: [] },
    slack: {
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
      oauth: { clientId: '1601185624273.8899143856786', callbackPort: 3118 },
    },
  },
};

function writeConfig(withBom: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcpbom-'));
  const p = join(dir, 'mcp.json');
  const body = JSON.stringify(CONFIG, null, 2);
  writeFileSync(p, (withBom ? '\uFEFF' : '') + body, 'utf8');
  return p;
}

describe('readJsonConfig', () => {
  it('parses a file that starts with a UTF-8 BOM (what PowerShell 5.1 writes)', async () => {
    const { readJsonConfig } = await import('../electron/mcp');
    const j = readJsonConfig(writeConfig(true));
    expect(Object.keys(j.mcpServers)).toEqual(['atlassian', 'slack']);
    expect(j.mcpServers.slack.url).toBe('https://mcp.slack.com/mcp');
  });

  it('still parses a normal file without a BOM', async () => {
    const { readJsonConfig } = await import('../electron/mcp');
    const j = readJsonConfig(writeConfig(false));
    expect(Object.keys(j.mcpServers)).toEqual(['atlassian', 'slack']);
  });

  it('plain JSON.parse really does reject the BOM - the bug this guards against', () => {
    const text = '\uFEFF' + JSON.stringify(CONFIG);
    expect(() => JSON.parse(text)).toThrow();
  });

  it('every config read in mcp.ts goes through the BOM-tolerant reader', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(__dirname, '..', 'electron', 'mcp.ts'), 'utf8');
    // The only raw parse allowed is the one inside readJsonConfig itself,
    // which strips the BOM first.
    const raw = src.match(/JSON\.parse\(readFileSync\([^\n]*/g) ?? [];
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatch(/\.replace\(\/\^\\uFEFF\/, ''\)/);
    expect((src.match(/readJsonConfig\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
