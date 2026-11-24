/**
 * Fixtures for the plugin rooms tests (design 11b / 11c): a real in-process
 * relay, real Guy Code A2ANodes (../rooms/roomHelpers) and real a2a-peer
 * DaemonCores, all relay-only (`listen: false`), so nobody listens on a port.
 * Each Claude Code session that joins a room gets its own identity and relay
 * stream inside the daemon - nothing between them is mocked.
 */
import { afterEach } from 'vitest';
import type { A2ANode } from '../../../electron/a2a/node';
import { relayOpts } from '../relay/relayHelpers';
import { until, type RoomsEnv } from '../rooms/roomHelpers';
import { makeDaemon, type TestDaemon } from './pluginHelpers';
import type { OpCtx } from '../../../integrations/claude-code-a2a/plugins/a2a-peer/src/ops';
import type { SqlHandle } from '../../../electron/a2a/store';

export type RoomDaemon = TestDaemon & { sql: SqlHandle };

const daemons: RoomDaemon[] = [];

/** Register after useRooms(): stops every daemon a test started. */
export function useDaemons(): void {
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.core.stop().catch(() => {});
  });
}

/** One a2a-peer daemon on the relay, relay-only, with registered Claude Code sessions (id -> cwd). */
export async function plugin(env: RoomsEnv, name: string, certIndex: number, sessions: Record<string, string>, reuse?: RoomDaemon): Promise<RoomDaemon> {
  const d = await makeDaemon({
    name,
    certIndex,
    relay: relayOpts(env.relay.port, { backoff: { baseMs: 20, maxMs: 100 } }),
    listen: false,
    reuse: reuse ? { sql: reuse.sql, secrets: reuse.secrets, auditPath: reuse.auditPath, clock: reuse.clock } : undefined,
  });
  for (const [sessionId, cwd] of Object.entries(sessions)) d.core.cc.registerSession({ sessionId, cwd });
  await until(() => !!d.core.node.relayClient()?.isConnected());
  daemons.push(d);
  return d;
}

export function ctx(d: RoomDaemon, sessionId: string): OpCtx {
  return { sessionId, cwd: d.core.cc.getSession(sessionId)?.cwd ?? null };
}

/** Everything handed to one Claude Code session through the inbox (channel + hook path). */
export function inboxOf(d: RoomDaemon, sessionId: string): string {
  return d.core.cc
    .recent(500)
    .filter((r) => r.routed_session === sessionId)
    .map((r) => r.envelope)
    .join('\n');
}

export const CODE_RE = /a2r1:[A-Za-z0-9_-]+/;

/** Wait until every (node, member) sees `n` active members and the same key epoch. */
export async function settled(pairs: Array<[A2ANode, string]>, roomId: string, n: number): Promise<void> {
  await until(() => pairs.every(([node, s]) => node.roomStore.listMembers(s, roomId).length === n), 5_000);
  await until(() => new Set(pairs.map(([node, s]) => node.roomStore.getRoom(s, roomId)?.epoch)).size === 1, 5_000);
}
