/**
 * Guy Code and the Claude Code a2a-peer plugin must not fight over a port.
 *
 * Plenty of people run both on one machine. They used to share a default of
 * 7427 - the plugin literally imported Guy Code's DEFAULT_PORT and its
 * manifest said "the same default as Guy Code" - so whichever started second
 * failed to bind with a bare EADDRINUSE, and the firewall rule the user had
 * already added pointed at the wrong executable. They now default to 7427 and
 * 7428 respectively.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_CODE_DEFAULT_PORT, DEFAULT_PORT } from '../../electron/a2a/config';

const PLUGIN = join(__dirname, '..', '..', 'integrations', 'claude-code-a2a', 'plugins', 'a2a-peer');

describe('default ports', () => {
  it('the two defaults differ, so both can run side by side', () => {
    expect(DEFAULT_PORT).toBe(7427);
    expect(CLAUDE_CODE_DEFAULT_PORT).toBe(7428);
    expect(CLAUDE_CODE_DEFAULT_PORT).not.toBe(DEFAULT_PORT);
  });

  it('the plugin manifest advertises its own default, not Guy Code\'s', () => {
    const manifest = JSON.parse(
      readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8')
    );
    expect(manifest.userConfig.port.default).toBe(CLAUDE_CODE_DEFAULT_PORT);
    // The old description claimed it matched Guy Code. It must not say that
    // again, because it is the thing that caused the clash.
    expect(manifest.userConfig.port.description).not.toMatch(/same default as Guy Code/i);
    expect(String(manifest.userConfig.port.description)).toContain(String(DEFAULT_PORT));
  });

  it('the daemon falls back to the plugin default, never Guy Code\'s', () => {
    const src = readFileSync(join(PLUGIN, 'src', 'daemon.ts'), 'utf8');
    expect(src).toMatch(/CLAUDE_CODE_DEFAULT_PORT/);
    // Importing DEFAULT_PORT here is exactly how the two collided before.
    expect(src).not.toMatch(/\bDEFAULT_PORT\b(?!.*CLAUDE)/);
  });
});

describe('a port clash explains itself', () => {
  it('EADDRINUSE is translated into advice naming both defaults', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'electron', 'a2a', 'server.ts'), 'utf8');
    const at = src.indexOf("code === 'EADDRINUSE'");
    expect(at).toBeGreaterThan(-1);
    const msg = src.slice(at, at + 700);
    expect(msg).toMatch(/already in use/);
    expect(msg).toMatch(/7427/);
    expect(msg).toMatch(/7428/);
    // Keep the underlying error so a different cause is still diagnosable.
    expect(msg).toMatch(/Original error/);
  });
});
