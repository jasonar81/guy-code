/**
 * Fixtures for the relay client tests: a real in-process RelayServer (relay/,
 * plain HTTP on 127.0.0.1:0) and real A2ANodes connected to it through the
 * real RelayClient. Nothing between them is mocked.
 */
import { startRelay as startRelayServer, sleep, until } from '../../relay/helpers';
import { makeNode, type TestNode } from '../helpers';
import type { RelayNodeOptions } from '../../../electron/a2a/node';
import type { RelayLimits } from '../../../relay/src/server';
import type { RelayDropNotice } from '../../../electron/a2a/relayClient';

export { sleep, until };

export type Relay = Awaited<ReturnType<typeof startRelayServer>>;

/** Generous connect limits: these tests reconnect on purpose. */
export function startRelay(limits: Partial<RelayLimits> = {}, opts: { fakeClock?: boolean } = {}): Promise<Relay> {
  return startRelayServer({ connectsPerMinutePerIp: 10_000, sendsPerMinutePerAgent: 10_000, ...limits }, opts);
}

export function relayOpts(port: number, over: Partial<RelayNodeOptions> = {}): RelayNodeOptions {
  return { url: `http://127.0.0.1:${port}`, backoff: { baseMs: 30, maxMs: 200 }, replyWaitMs: 5_000, ...over };
}

export interface RelayNode extends TestNode {
  dropped: RelayDropNotice[];
}

/**
 * A node on the relay. `listen: false` = a laptop behind the VPN: it never
 * opens a listening socket, and its card URL is relay://<fingerprint>.
 */
export async function makeRelayNode(opts: { name: string; certIndex: number; relayPort: number; listen?: boolean; relay?: Partial<RelayNodeOptions> }): Promise<RelayNode> {
  const dropped: RelayDropNotice[] = [];
  const t = await makeNode({
    name: opts.name,
    certIndex: opts.certIndex,
    extra: {
      listen: opts.listen ?? false,
      relay: relayOpts(opts.relayPort, opts.relay),
      onRelayDropped: (n) => void dropped.push(n),
    },
  });
  await connected(t);
  return Object.assign(t, { dropped });
}

export async function connected(t: TestNode, timeoutMs = 5_000): Promise<void> {
  await until(() => !!t.node.relayClient()?.isConnected(), timeoutMs);
}

/** a invites, b redeems, whichever transport works. */
export async function pairNodes(a: TestNode, b: TestNode): Promise<{ aSeesB: string; bSeesA: string }> {
  const { code } = a.node.invite();
  const peerA = await b.node.redeem(code);
  const peerB = a.node.store.listPeers().find((p) => p.cert_sha256 === b.node.fingerprint())!;
  return { aSeesB: peerB.peer_id, bSeesA: peerA.peer_id };
}
