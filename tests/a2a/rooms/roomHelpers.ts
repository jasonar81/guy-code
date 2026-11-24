/**
 * Fixtures for the rooms tests (design 11b / 11c): a real in-process relay
 * and real A2ANodes with sessions. Every session that joins a room gets its
 * own identity and its own relay connection - nothing between them is mocked.
 */
import { afterEach } from 'vitest';
import { RelayClient } from '../../../electron/a2a/relayClient';
import type { SealedEnvelope } from '../../../electron/a2a/relayCrypto';
import type { WaitA2AState, WaitPort } from '../../../electron/a2a/waiters';
import { makeNode, session, type TestNode } from '../helpers';
import { connected, relayOpts, startRelay, until, type Relay } from '../relay/relayHelpers';

export { until };

export interface RoomsEnv {
  relay: Relay;
  nodes: TestNode[];
  /** Every sealed room post any client sent (what the relay saw), for the no-plaintext checks. */
  wire: Array<{ room: string; msgId: string; sealed: SealedEnvelope }>;
}

let current: RoomsEnv | null = null;
const origPost = RelayClient.prototype.postRoom;

export function useRooms(): () => RoomsEnv {
  afterEach(async () => {
    RelayClient.prototype.postRoom = origPost;
    if (!current) return;
    for (const n of current.nodes) await n.node.stop().catch(() => {});
    await current.relay.close().catch(() => {});
    current = null;
  });
  return () => current!;
}

export async function setup(): Promise<RoomsEnv> {
  const relay = await startRelay();
  const wire: RoomsEnv['wire'] = [];
  RelayClient.prototype.postRoom = function (room: string, msgId: string, sealed: SealedEnvelope) {
    wire.push({ room, msgId, sealed });
    return origPost.call(this, room, msgId, sealed);
  };
  current = { relay, nodes: [], wire };
  return current;
}

/** A WaitPort backed by a map, recording every resume (the push wake path). */
export function memWaits() {
  const waiting = new Map<string, WaitA2AState>();
  const resumed: Array<{ sessionId: string; note: string }> = [];
  const port: WaitPort = {
    listWaiting: () => [...waiting.entries()].map(([sessionId, state]) => ({ sessionId, state })),
    resume: (sessionId, note) => {
      waiting.delete(sessionId);
      resumed.push({ sessionId, note });
    },
  };
  return { waiting, resumed, port };
}

export type Install = TestNode & { waits: ReturnType<typeof memWaits> };

/** One Guy Code install (relay-only, like a laptop on the VPN) with the given sessions. */
export async function install(env: RoomsEnv, name: string, certIndex: number, sessionIds: string[]): Promise<Install> {
  const waits = memWaits();
  const t = await makeNode({
    name,
    certIndex,
    rows: sessionIds.map((id) => session({ id, title: `${name} ${id}` })),
    extra: { listen: false, relay: relayOpts(env.relay.port, { backoff: { baseMs: 20, maxMs: 100 } }), waits: waits.port },
  });
  await connected(t);
  const out = Object.assign(t, { waits });
  env.nodes.push(out);
  return out;
}

/** What one session was handed (turns + interrupts), joined. */
export function seen(t: TestNode, sessionId: string): string {
  return [...t.port.turns.filter((x) => x.sessionId === sessionId), ...t.port.interrupts.filter((x) => x.sessionId === sessionId)].map((x) => x.text).join('\n');
}

/** `owner` invites into `roomRef`, `joiner` redeems. Resolves once admitted. */
export async function admit(host: TestNode, owner: string, roomRef: string, guest: TestNode, joiner: string): Promise<void> {
  const { code } = host.node.rooms.invite(owner, roomRef);
  const r = await guest.node.rooms.redeem(joiner, code);
  if (r.status !== 'active') throw new Error('join did not complete');
}

/** Wait until every listed session sees `n` active members in the room. */
export async function rosterSettled(pairs: Array<[TestNode, string]>, roomId: string, n: number): Promise<void> {
  await until(() => pairs.every(([t, s]) => t.node.roomStore.listMembers(s, roomId).length === n), 5_000);
  // ...and every member has the same (newest) key.
  await until(() => new Set(pairs.map(([t, s]) => t.node.roomStore.getRoom(s, roomId)?.epoch)).size === 1, 5_000);
}
