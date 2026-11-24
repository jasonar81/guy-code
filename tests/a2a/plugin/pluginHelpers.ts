/**
 * Fixtures for the a2a-peer plugin tests (design 10 P4). There is no Claude
 * Code on the test machines, so the pieces are tested directly:
 *   - a real DaemonCore (the plugin's endpoint, built on Guy Code's A2ANode)
 *     on 127.0.0.1:0 with a freshly generated certificate and real TLS;
 *   - a real Guy Code A2ANode from ../helpers, paired with it over TLS;
 *   - a recording "channel" subscriber standing in for a connected MCP
 *     server (channels ON), or none at all (channels OFF);
 *   - a recording watch runner, so the clock and exit codes are
 *     deterministic and every command handed to a shell is captured.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonCore, type ChannelSubscriber } from '../../../integrations/claude-code-a2a/plugins/a2a-peer/src/core';
import { openMemoryDb } from '../../../integrations/claude-code-a2a/plugins/a2a-peer/src/db';
import type { WatchCheckFn, WatchCheckResult } from '../../../electron/a2a/watch';
import type { RelayNodeOptions } from '../../../electron/a2a/node';
import type { SqlHandle } from '../../../electron/a2a/store';
import { cert, memSecrets, type TestNode } from '../helpers';

export interface TestDaemon {
  core: DaemonCore;
  secrets: ReturnType<typeof memSecrets>;
  clock: { now: number };
  auditPath: string;
}

export async function makeDaemon(opts: {
  name: string;
  certIndex: number;
  watchCheck?: WatchCheckFn;
  /** Rooms tests: relay settings and relay-only mode. */
  relay?: RelayNodeOptions | null;
  listen?: boolean;
  /** Restart tests: reuse a previous daemon's database, secrets and audit file. */
  reuse?: { sql: SqlHandle; secrets: ReturnType<typeof memSecrets>; auditPath: string; clock: { now: number } };
}): Promise<TestDaemon & { sql: SqlHandle }> {
  const sql = opts.reuse?.sql ?? (await openMemoryDb()).sql;
  const secrets = opts.reuse?.secrets ?? memSecrets();
  const clock = opts.reuse?.clock ?? { now: Date.now() };
  const auditPath = opts.reuse?.auditPath ?? join(mkdtempSync(join(tmpdir(), 'a2a-plugin-')), 'audit.jsonl');
  const core = new DaemonCore({
    sql,
    secrets,
    auditPath,
    tls: cert(opts.certIndex),
    host: '127.0.0.1',
    port: 0,
    allowCidrs: () => ['127.0.0.0/8'],
    displayName: opts.name,
    userName: opts.name.toLowerCase(),
    appVersion: 'test',
    now: () => clock.now,
    autoFlush: false,
    autoWatch: false,
    watchCheck: opts.watchCheck,
    relay: opts.relay ?? null,
    listen: opts.listen,
  });
  await core.start();
  return { core, secrets, clock, auditPath, sql };
}

/** Guy Code node invites; the daemon redeems. Returns each side's handle for the other. */
export async function pairWithGuy(guy: TestNode, d: TestDaemon): Promise<{ guySeesDaemon: string; daemonSeesGuy: string }> {
  const { code } = guy.node.invite();
  const p = await d.core.node.redeem(code);
  const back = guy.node.store.listPeers().find((x) => x.card_url === d.core.node.cardUrl())!;
  return { guySeesDaemon: back.peer_id, daemonSeesGuy: p.peer_id };
}

/** A connected MCP channel, as the daemon sees it. Records every event it is sent. */
export function channel(d: TestDaemon, conn: string, sessionId: string): ChannelSubscriber & { events: Array<{ event: string; data: any }> } {
  const sub = {
    sessionId,
    events: [] as Array<{ event: string; data: any }>,
    send(event: 'item' | 'digest', data: unknown) {
      sub.events.push({ event, data });
      return true;
    },
  };
  d.core.subscribe(conn, sub);
  return sub;
}

/** A check runner that records every command and returns what the test says. */
export function fakeCheck(output = 'bench_p5.py: 0 failures') {
  const calls: Array<{ command: string; cwd: string; shell: string }> = [];
  const ctl = { code: 1, launched: true, output, calls };
  const fn: WatchCheckFn = async (command, cwd, shell) => {
    calls.push({ command, cwd, shell });
    const r: WatchCheckResult = { code: ctl.code, launched: ctl.launched, output: ctl.output };
    return r;
  };
  return { ctl, fn };
}
