/**
 * Inbound message -> local session (design 6.3).
 *
 * The router owns three decisions and nothing else:
 *   1. gate: deliver now, hold for the user's approval, or refuse (design
 *      4.2.3 / 6.3 step 4). `inform` is delivered from any non-blocked peer;
 *      `request` / `notify` from an `inform` peer wait for Accept; from
 *      `collaborate` or `full` they are delivered now;
 *   2. route: which session gets it (order from design 5.4);
 *   3. deliver: interrupt a running turn, start a turn, or queue behind a wait
 *      (mirrors slackBridge.handleCommand "send").
 *
 * It never hands raw peer text to a session: every delivery goes through
 * `buildEnvelope` (design 4.2.4). Session access is injected (`SessionPort`)
 * so the router is testable without agent.ts and Electron.
 */
/**
 * The final segment of a path, accepting either separator regardless of the
 * host OS, with any trailing separators ignored. Peers run on other operating
 * systems, so their `cwd` can use the other separator.
 */
export function lastPathSegment(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}
import { buildEnvelope, type EnvelopeDialect } from './envelope';
import { errors } from './errors';
import type { PeerRow } from './store';
import { trustAtLeast, type MessageKind, type RoutingInfo, type TrustLevel } from './types';

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
  /**
   * True when the session is sleeping in WaitForA2A on this peer, context or
   * task (design 6.3 step 5): a message it is waiting for wakes it instead
   * of queueing behind the wait. Optional; absent means "no".
   */
  isWaitingFor?(sessionId: string, on: { peerId: string; contextId: string; taskId: string }): boolean;
}

export type RouteVia = 'context' | 'toSession' | 'toProject' | 'inbox';
export type DeliveryMode = 'interrupt' | 'turn' | 'queued' | 'wake';
export type GateDecision = 'deliver' | 'approve';

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
  /** `metadata.urgent === true`: honoured only from trust >= collaborate (design 6.3 step 5). */
  urgent?: boolean;
  /** For a `full` peer's envelope header. */
  fullGrantedTs?: number | null;
  fullExpiresTs?: number | null;
  /** Which runtime's tool names the envelope's reply hint uses (default Guy Code). */
  dialect?: EnvelopeDialect;
}

/**
 * Trust gate (design 4.2.3, 6.3 step 4). Throws for a blocked peer (the
 * server already stopped it with 403 before reading a body; repeated here so
 * the router is safe on its own). Otherwise:
 *   - inform from anyone: deliver now, it is information only;
 *   - request / notify from collaborate or full: deliver now;
 *   - request / notify from inform: hold for the local user's approval.
 * `trust` is the EFFECTIVE trust, so an expired escalation or the global
 * pause has already been applied by the caller.
 */
export function gate(kind: MessageKind, trust: TrustLevel): GateDecision {
  if (trust === 'blocked') throw errors.blocked();
  if (kind === 'inform') return 'deliver';
  return trustAtLeast(trust, 'collaborate') ? 'deliver' : 'approve';
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
  // A peer's model sometimes passes a whole path ("C:\Users\dylan\xgsrc")
  // rather than the folder name. Take the last segment, on either separator,
  // so it still matches whatever OS this side runs on.
  const toProject = typeof m.routing.toProject === 'string' ? lastPathSegment(m.routing.toProject.trim()).toLowerCase() : '';
  if (toProject) {
    const inProject = rows.filter((r) => {
      // Split on BOTH separators whatever the host OS. `basename` from
      // node:path is platform-specific: on POSIX it treats "C:\w\xgsrc" as a
      // single filename, so a peer on Windows would never match a project
      // here and we would silently route to an older session instead. CI
      // caught exactly that - the test passed on Windows and failed on Linux
      // and macOS.
      const name = r.cwd ? lastPathSegment(r.cwd).toLowerCase() : '';
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
export function deliveryMode(session: RoutableSession, running: boolean, opts: { waitingForThis?: boolean; urgent?: boolean } = {}): DeliveryMode {
  if (running) return 'interrupt';
  // A session sleeping in WaitForA2A on exactly this peer / context / task is
  // woken: the message is what it was waiting for. An `urgent` flag (only
  // honoured from trust >= collaborate, checked by the caller) also wakes a
  // tool sleep. Starting a turn cancels the wait (agent.ts runUserTurn).
  if (session.state === 'sleeping-tool' && (opts.waitingForThis || opts.urgent)) return 'wake';
  switch (session.state) {
    // Sleeping in WaitForTime / WaitForCondition / an unrelated WaitForA2A,
    // or parked by the budget governor: do not break the wait. The queued
    // text is picked up by the next runUserTurn (agent.ts drains interrupts
    // at turn start).
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
  if (gate(m.kind, m.trust) !== 'deliver') {
    // The node holds these for approval and calls deliverRouted on Accept;
    // reaching here would hand an unapproved request to a session.
    throw new Error('router.deliver called for a message that needs approval');
  }
  const { session, via } = routeSession(port, m);
  return deliverRouted(port, session, via, m);
}

/** Wrap and hand over to a session that has already been chosen. No gate: the caller has decided. */
export function deliverRouted(port: SessionPort, session: RoutableSession, via: RouteVia, m: InboundForRouting): DeliveryResult {
  const envelope = buildEnvelope({
    peerId: m.peer.peer_id,
    displayName: m.peer.display_name,
    agentKind: m.peer.agent_kind,
    trust: m.trust,
    kind: m.kind,
    taskId: m.taskId,
    contextId: m.contextId,
    fromSessionLabel: m.routing.fromSessionLabel,
    fromProject: m.routing.fromProject,
    text: m.text,
    fullGrantedTs: m.fullGrantedTs,
    fullExpiresTs: m.fullExpiresTs,
    dialect: m.dialect,
  });
  const waitingForThis = !!port.isWaitingFor?.(session.id, { peerId: m.peer.peer_id, contextId: m.contextId, taskId: m.taskId });
  const urgent = !!m.urgent && trustAtLeast(m.trust, 'collaborate');
  const mode = deliveryMode(session, port.isRunning(session.id), { waitingForThis, urgent });
  if (mode === 'turn' || mode === 'wake') {
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