/**
 * Inbound message -> local session (design 6.3), P1: inform only.
 *
 * The router owns three decisions and nothing else:
 *   1. gate: is this kind of message from this peer allowed right now?
 *   2. route: which session gets it (order from design 5.4);
 *   3. deliver: interrupt a running turn, start a turn, or queue behind a wait
 *      (mirrors slackBridge.handleCommand "send").
 *
 * It never hands raw peer text to a session: every delivery goes through
 * `buildEnvelope` (design 4.2.4). Session access is injected (`SessionPort`)
 * so the router is testable without agent.ts and Electron.
 */
import { basename } from 'node:path';
import { buildEnvelope } from './envelope';
import { errors } from './errors';
import type { PeerRow } from './store';
import type { MessageKind, RoutingInfo, TrustLevel } from './types';

/** The session fields routing needs. Structurally a subset of db.SessionFullRow. */
export interface RoutableSession {
  id: string;
  project_id: string;
  cwd: string | null;
  jsonl_path: string;
  jsonl_mtime: number;
  state: string;
  archived: number;
  title: string | null;
  user_title: string | null;
}

export interface SessionPort {
  listSessions(): RoutableSession[];
  /** slackBridge.resolveSession in production: id prefix or ranked fuzzy name match. */
  resolveSession(rows: RoutableSession[], ref: string): { session?: RoutableSession; error?: string };
  isRunning(sessionId: string): boolean;
  queueInterrupt(sessionId: string, text: string): void;
  /** Start a turn with `text` as the user message (fire and forget). */
  startTurn(session: RoutableSession, text: string): void;
  /** The dedicated "A2A inbox" session, created on demand (design 5.4). */
  getOrCreateInboxSession(): RoutableSession;
  /** Desktop / UI notification when a message is parked behind a wait. Optional. */
  notify?(title: string, body: string): void;
}

export type RouteVia = 'context' | 'toSession' | 'toProject' | 'inbox';
export type DeliveryMode = 'interrupt' | 'turn' | 'queued';

export interface InboundForRouting {
  peer: PeerRow;
  trust: TrustLevel;
  kind: MessageKind;
  contextId: string;
  taskId: string;
  text: string;
  routing: RoutingInfo;
  /** session_id already mapped to this contextId (for this peer), if any. */
  mappedSessionId: string | null;
}

/**
 * Trust gate. Throws a protocol error for anything P1 does not deliver.
 * `blocked` peers are already stopped with 403 by the server before a body is
 * read; the check is repeated here so the router is safe on its own.
 */
export function gate(kind: MessageKind, trust: TrustLevel): void {
  if (trust === 'blocked') throw errors.blocked();
  if (kind === 'inform') return; // design 6.3 step 4: inform from any non-blocked peer is delivered now.
  // TODO(P2): `request` and `notify` kinds. From an `inform` peer they are held
  // as pending approval (task -> TASK_STATE_INPUT_REQUIRED, "Waiting for <user>
  // to approve", desktop notification + Agents panel badge + Slack line); from
  // `collaborate` / `full` they are delivered now (full with its own envelope).
  // P1 has no tasks with a lifecycle, so refuse rather than pretend.
  throw errors.unsupportedOperation(
    `This agent accepts "inform" messages only for now; "${kind}" requests arrive in a later version. Send it as information instead.`
  );
}

function liveRows(port: SessionPort): RoutableSession[] {
  return port.listSessions().filter((s) => s.archived === 0);
}

/** Pick the session (design 5.4 order): context mapping, toSession, toProject, inbox. */
export function routeSession(port: SessionPort, m: Pick<InboundForRouting, 'mappedSessionId' | 'routing'>): { session: RoutableSession; via: RouteVia } {
  const rows = liveRows(port);
  if (m.mappedSessionId) {
    const s = rows.find((r) => r.id === m.mappedSessionId);
    if (s) return { session: s, via: 'context' };
  }
  const toSession = typeof m.routing.toSession === 'string' ? m.routing.toSession.trim() : '';
  if (toSession) {
    const r = port.resolveSession(rows, toSession);
    if (r.session) return { session: r.session, via: 'toSession' };
  }
  const toProject = typeof m.routing.toProject === 'string' ? m.routing.toProject.trim().toLowerCase() : '';
  if (toProject) {
    const inProject = rows.filter((r) => {
      const name = r.cwd ? basename(r.cwd.replace(/[\\/]+$/, '')).toLowerCase() : '';
      return name === toProject || r.project_id.toLowerCase() === toProject;
    });
    if (inProject.length) {
      inProject.sort((a, b) => (b.jsonl_mtime ?? 0) - (a.jsonl_mtime ?? 0));
      return { session: inProject[0], via: 'toProject' };
    }
  }
  return { session: port.getOrCreateInboxSession(), via: 'inbox' };
}

/**
 * How to get text into a session without breaking what it is doing
 * (design 6.3 step 5).
 */
export function deliveryMode(session: RoutableSession, running: boolean): DeliveryMode {
  if (running) return 'interrupt';
  switch (session.state) {
    // Sleeping in WaitForTime / WaitForCondition, or parked by the budget
    // governor: do not break the wait. The queued text is picked up by the
    // next runUserTurn (agent.ts drains interrupts at turn start).
    // TODO(P2): a session sleeping in WaitForA2A on this peer/context/task is
    // woken instead, and an `urgent` flag from trust >= collaborate wakes too.
    case 'sleeping-tool':
    case 'sleeping-budget':
    case 'waiting-on-system':
      return 'queued';
    default:
      // idle, waiting-on-user (WaitForUser), error: start a turn, exactly as
      // the Slack bridge does for "send".
      return 'turn';
  }
}

export interface DeliveryResult {
  sessionId: string;
  via: RouteVia;
  mode: DeliveryMode;
  envelope: string;
}

export function deliver(port: SessionPort, m: InboundForRouting): DeliveryResult {
  gate(m.kind, m.trust);
  const { session, via } = routeSession(port, m);
  const envelope = buildEnvelope({
    peerId: m.peer.peer_id,
    displayName: m.peer.display_name,
    agentKind: m.peer.agent_kind,
    trust: m.trust,
    taskId: m.taskId,
    contextId: m.contextId,
    fromSessionLabel: m.routing.fromSessionLabel,
    fromProject: m.routing.fromProject,
    text: m.text,
  });
  const mode = deliveryMode(session, port.isRunning(session.id));
  if (mode === 'turn') {
    port.startTurn(session, envelope);
  } else {
    port.queueInterrupt(session.id, envelope);
    if (mode === 'queued') {
      const name = (session.user_title || session.title || 'a session').trim();
      port.notify?.(
        `Agent message from ${m.peer.display_name || m.peer.peer_id}`,
        `Queued for "${name}" until its current wait ends.`
      );
    }
  }
  return { sessionId: session.id, via, mode, envelope };
}
