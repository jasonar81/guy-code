/**
 * The a2a-peer daemon's core: one A2A endpoint per person (design 3, 7.2),
 * the same endpoint Guy Code runs, with Claude Code sessions behind it.
 *
 * `A2ANode` is Guy Code's own class (electron/a2a/node.ts, through
 * shared/protocol.ts): HTTPS with a pinned self-signed cert, pairing, the
 * HTTP+JSON routes, trust gating, push in and out, the outbox and its retry
 * rules, the audit log and the watch runner. This file adds only what is
 * different about Claude Code:
 *   - sessions are `cc_sessions` rows registered by the SessionStart hook,
 *     and "deliver to a session" means "write an inbox row" (port.ts);
 *   - a request / notify from an `inform` peer cannot wait for a Guy
 *     Code-style Accept button (the daemon has no UI), so it is delivered to
 *     Claude with "ask your user first" and stays INPUT_REQUIRED until Claude
 *     calls a2a_reply / a2a_watch after the user agrees (design 7.2);
 *   - updates on tasks WE asked for become `task_update` inbox items, which
 *     is how "tell us when" resumes a Claude Code conversation (design 7.3:
 *     end the turn, the answer arrives as a channel event or hook context);
 *   - live MCP connections subscribe to their session's items over SSE.
 *
 * Nothing here ever runs a command because of an inbound message. The only
 * path to a shell is `node.watch`, reached solely from the a2a_watch tool
 * with the local agent's own arguments (watch.ts SECURITY, design 5.5).
 */
import { randomUUID } from 'node:crypto';
import {
  A2ANode,
  buildEnvelope,
  stateWakes,
  stateWord,
  type A2ATaskEvent,
  type PeerRow,
  type SecretPort,
  type SqlHandle,
  type TaskRow,
  type TlsIdentity,
  type WatchCheckFn,
  type RelayNodeOptions,
} from './shared/protocol';
import { CcStore, type InboxRow } from './inbox';
import { ccSessionPort, HELD, metaFromEnvelope, roomEnvelopeForClaude } from './port';

export interface DaemonCoreOptions {
  sql: SqlHandle;
  secrets: SecretPort;
  auditPath: string;
  tls: TlsIdentity;
  host: string;
  port: number;
  advertiseHost?: string;
  allowCidrs: () => string[];
  displayName: string;
  userName?: string;
  appVersion?: string;
  now?: () => number;
  watchCheck?: WatchCheckFn;
  /** Tests switch the timers off and drive flushOutbox / sweepWatches themselves. */
  autoFlush?: boolean;
  autoWatch?: boolean;
  verifyPeerCardOnPair?: boolean;
  /** Relay transport (design 11a); null/omitted = off. */
  relay?: RelayNodeOptions | null;
  /** False = relay-only, never listen on a port. */
  listen?: boolean;
}

/** A live MCP connection's event stream (daemon.ts wires SSE; tests use a recorder). */
export interface ChannelSubscriber {
  sessionId: string | null;
  /** Claude Code's pid (the MCP process's parent) and cwd, for session correlation (design Q2). */
  ccPid?: number | null;
  cwd?: string | null;
  send(event: 'item' | 'digest', data: unknown): boolean;
}

export class DaemonCore {
  readonly node: A2ANode;
  readonly cc: CcStore;
  readonly now: () => number;
  private readonly subscribers = new Map<string, ChannelSubscriber>();
  private muted = false;

  constructor(readonly opts: DaemonCoreOptions) {
    this.now = opts.now ?? Date.now;
    this.cc = new CcStore(opts.sql, this.now);
    const port = ccSessionPort(this.cc, { added: (row) => this.pushItem(row) }, () => this.muted);
    this.node = new A2ANode({
      sql: opts.sql,
      secrets: opts.secrets,
      sessions: port,
      auditPath: opts.auditPath,
      tls: opts.tls,
      host: opts.host,
      port: opts.port,
      advertiseHost: opts.advertiseHost,
      allowCidrs: opts.allowCidrs,
      displayName: opts.displayName,
      userName: opts.userName,
      agentKind: 'claude-code',
      envelopeDialect: 'claude-code',
      appVersion: opts.appVersion,
      now: this.now,
      autoFlush: opts.autoFlush,
      autoWatch: opts.autoWatch,
      watchCheck: opts.watchCheck,
      verifyPeerCardOnPair: opts.verifyPeerCardOnPair,
      relay: opts.relay ?? null,
      listen: opts.listen,
      onApprovalNeeded: (task, peer, text) => this.onApprovalNeeded(task, peer, text),
      onTaskEvent: (ev) => this.onTaskEvent(ev),
    });
  }

  start(): Promise<void> {
    return this.node.start();
  }

  stop(): Promise<void> {
    for (const id of [...this.subscribers.keys()]) this.subscribers.delete(id);
    return this.node.stop();
  }

  // ---- channel subscribers ---------------------------------------------------

  subscribe(conn: string, sub: ChannelSubscriber): void {
    this.subscribers.set(conn, sub);
  }

  unsubscribe(conn: string): void {
    this.subscribers.delete(conn);
  }

  /**
   * Re-run session correlation for every live connection. Called after a
   * SessionStart registers a session: the MCP server often connects BEFORE
   * the hook runs, and `/clear` starts a new session id in the same Claude
   * Code process. A connection that changes session gets the digest and its
   * unacked items replayed.
   */
  rebindAll(): void {
    for (const [conn, sub] of this.subscribers) {
      const s = this.cc.correlate({ ccPid: sub.ccPid ?? null, cwd: sub.cwd ?? null });
      if (s && s.session_id !== sub.sessionId) {
        this.bindConnection(conn, s.session_id);
        this.replayTo(conn);
      }
    }
  }

  /** The MCP connection learned (or changed) which session it belongs to. */
  bindConnection(conn: string, sessionId: string | null): void {
    const s = this.subscribers.get(conn);
    if (s) s.sessionId = sessionId;
    if (sessionId) this.cc.touchSession(sessionId, { mcpConnId: conn });
  }

  /**
   * Push a stored item to its session's live channel, if one is connected.
   * `delivered_ts` only means "written to the MCP stream": Claude Code gives
   * no acknowledgement, so the item stays unacked until a tool or the hook
   * proves Claude saw it.
   */
  pushItem(row: InboxRow): boolean {
    if (row.routed_session) for (const w of [...this.inboxWaiters]) if (w.sessionId === row.routed_session) w.resolve(row);
    let sent = false;
    for (const sub of this.subscribers.values()) {
      if (!sub.sessionId || (row.routed_session && sub.sessionId !== row.routed_session)) continue;
      if (!row.routed_session) continue; // held: nobody owns it yet
      if (sub.send('item', itemEvent(row))) sent = true;
    }
    if (sent) this.cc.markDelivered(row.id);
    this.node.audit.write({ event: 'cc.inbox', peer: row.peer ?? undefined, taskId: row.task_id, sessionId: row.routed_session, kind: row.kind, item: row.id, channel: sent });
    return sent;
  }

  /** Re-send everything unacked to a connection that has just (re)connected, after the digest. */
  replayTo(conn: string): void {
    const sub = this.subscribers.get(conn);
    if (!sub?.sessionId) return;
    const items = this.cc.unacked(sub.sessionId).filter((r) => r.routed_session === sub.sessionId);
    if (items.length) sub.send('digest', { content: this.digest(sub.sessionId), meta: { kind: 'digest', count: String(items.length) } });
    for (const r of items) if (sub.send('item', itemEvent(r))) this.cc.markDelivered(r.id);
  }

  // ---- inbound: approval and task updates ------------------------------------

  /**
   * A request / notify from an `inform` peer (design 7.2): the node has held
   * it at INPUT_REQUIRED "Waiting for <user> to approve". There is no Accept
   * button on this side, so hand it to Claude with the instruction to ask the
   * user first. The envelope's claude-code hint says exactly that.
   */
  private onApprovalNeeded(task: TaskRow, peer: PeerRow, text: string): void {
    const trust = this.node.effectiveTrust(peer);
    const envelope = buildEnvelope({
      peerId: peer.peer_id,
      displayName: peer.display_name,
      agentKind: peer.agent_kind,
      trust: trust === 'blocked' ? 'inform' : trust,
      kind: (task.kind as 'request' | 'notify') ?? 'request',
      taskId: task.task_id,
      contextId: task.context_id,
      text,
      dialect: 'claude-code',
    });
    const sessionId = task.session_id && task.session_id !== HELD && this.cc.getSession(task.session_id) ? task.session_id : null;
    const meta = metaFromEnvelope(envelope, { approval: 'pending' });
    const row = this.cc.addItem({ peer: peer.peer_id, taskId: task.task_id, contextId: task.context_id, sessionId, kind: meta.kind, envelope, meta });
    this.pushItem(row);
  }

  /**
   * An update on a task we created (push, poll, or our own cancel). Surfaced
   * when a default WaitForA2A would wake on it: terminal, a real
   * INPUT_REQUIRED (not "waiting for approval"), or a new agent message.
   * WORKING updates ("watching: ...") are recorded but not surfaced, so they
   * cost the user no model turn. The peer's words are inside the envelope.
   */
  private onTaskEvent(ev: A2ATaskEvent): void {
    if (ev.direction !== 'out') return;
    if (ev.kind === 'state' && !stateWakes(null, ev.state, ev.approvalPending)) return;
    const t = this.node.store.getTask(ev.taskId);
    if (t && ev.peerId.startsWith('room:')) return this.onRoomTaskEvent(t, ev);
    const peer = this.node.store.getPeer(ev.peerId);
    if (!t || !peer) return;
    const what = t.summary ? ` "${t.summary.replace(/\s+/g, ' ').slice(0, 80)}"` : '';
    const head =
      ev.kind === 'message'
        ? `[A2A task update] ${peer.peer_id}'s agent sent a message on your ${t.kind ?? ''} task ${t.task_id.slice(0, 8)}${what}.`
        : `[A2A task update] ${peer.peer_id}'s task ${t.task_id.slice(0, 8)}${what} -> ${stateWord(ev.state)}.`;
    const tail =
      'If this is what you were waiting for, continue the plan your user gave you and tell them in one line. ' +
      `For follow-ups use a2a_send with peer "${peer.peer_id}"${t.context_id ? ` and context_id "${t.context_id}"` : ''}.`;
    const envelope = `${head}\n${tail}\n${buildEnvelope({
      peerId: peer.peer_id,
      displayName: peer.display_name,
      agentKind: peer.agent_kind,
      trust: this.node.effectiveTrust(peer) === 'blocked' ? 'inform' : this.node.effectiveTrust(peer),
      kind: 'inform',
      taskId: t.task_id,
      contextId: t.context_id,
      text: ev.text || `(no text; the task is now ${stateWord(ev.state)})`,
      dialect: 'claude-code',
    })}`;
    const owner = t.session_id && this.cc.getSession(t.session_id) ? t.session_id : this.cc.routable()[0]?.id ?? null;
    const meta = metaFromEnvelope(envelope, { kind: 'task_update', state: stateWord(ev.state), task_id: t.task_id });
    const row = this.cc.addItem({ peer: peer.peer_id, taskId: t.task_id, contextId: t.context_id, sessionId: owner, kind: 'task_update', envelope, meta });
    this.pushItem(row);
  }

  /**
   * A member answered one of OUR room requests (A2ANode.roomReply). A room
   * task has no peer row - its peer_id is `room:<id>` - so the pairwise path
   * above would drop it. The member's words still go inside the envelope.
   */
  private onRoomTaskEvent(t: TaskRow, ev: A2ATaskEvent): void {
    const roomId = ev.peerId.slice('room:'.length);
    const owner = t.session_id && this.cc.getSession(t.session_id) ? t.session_id : null;
    const room = owner ? this.node.roomStore.getRoom(owner, roomId) : undefined;
    const name = room?.display_name ?? roomId.slice(0, 8);
    const what = t.summary ? ` "${t.summary.replace(/\s+/g, ' ').slice(0, 80)}"` : '';
    const head =
      ev.kind === 'message'
        ? `[A2A task update] a member of room "${name}" answered your ${t.kind ?? ''} ${t.task_id.slice(0, 8)}${what}.`
        : `[A2A task update] your ${t.kind ?? ''} ${t.task_id.slice(0, 8)}${what} in room "${name}" -> ${stateWord(ev.state)}.`;
    const tail = `If this is what you were waiting for, continue the plan your user gave you and tell them in one line. To follow up, use a2a_post with room "${name}".`;
    const envelope = `${head}\n${tail}\n${roomEnvelopeForClaude(
      buildEnvelope({
        peerId: 'room-member',
        displayName: `a member of room "${name}"`,
        agentKind: 'other',
        trust: 'inform',
        kind: 'inform',
        taskId: t.task_id,
        room: name,
        text: ev.text || `(no text; the task is now ${stateWord(ev.state)})`,
        dialect: 'claude-code',
      })
    )}`;
    const meta = metaFromEnvelope(envelope, { kind: 'task_update', state: stateWord(ev.state), task_id: t.task_id, room: name });
    const row = this.cc.addItem({ peer: `room:${name}`, taskId: t.task_id, contextId: t.context_id, sessionId: owner, kind: 'task_update', envelope, meta });
    this.pushItem(row);
  }

  // ---- rooms: session lifecycle (design 11b "One identity per session") --------

  /**
   * A Claude Code session went away for good: leave its rooms (signed leave,
   * then a relay leave) and drop its identity - the cert row and the private
   * key in secrets.json. Never touches a session that has no identity.
   */
  async forgetRoomSession(sessionId: string, why: string): Promise<boolean> {
    if (!this.node.roomStore.getIdentity(sessionId) && !this.node.roomStore.listRooms(sessionId, true).length) return false;
    await this.node.forgetSession(sessionId);
    this.node.audit.write({ event: 'cc.session', sessionId, action: 'rooms_forgotten', reason: why });
    return true;
  }

  /**
   * Sessions that ended (SessionEnd without `/clear`) keep their identity and
   * rooms so `claude --resume` can carry on as the same member. One that has
   * not come back after SESSION_STALE_MS has gone away: forget it.
   */
  async sweepEndedRoomSessions(maxAgeMs = 7 * 24 * 3_600_000): Promise<number> {
    let n = 0;
    const now = this.now();
    for (const s of this.cc.listSessions(true)) {
      if (s.ended_ts == null || now - s.ended_ts < maxAgeMs) continue;
      if (await this.forgetRoomSession(s.session_id, 'ended')) n++;
    }
    return n;
  }

  // ---- wait for anything (design 11c): the inbox side ----------------------------

  private readonly inboxWaiters = new Set<{ sessionId: string; resolve(row: InboxRow): void }>();

  /** Resolve on the next inbox item routed to this session (pairwise message, task update, room message). */
  nextInboxItem(sessionId: string, signal: AbortSignal): Promise<InboxRow | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      const w = {
        sessionId,
        resolve: (row: InboxRow) => {
          this.inboxWaiters.delete(w);
          signal.removeEventListener('abort', onAbort);
          resolve(row);
        },
      };
      const onAbort = () => {
        this.inboxWaiters.delete(w);
        resolve(null);
      };
      signal.addEventListener('abort', onAbort);
      this.inboxWaiters.add(w);
    });
  }

  /** Accept a held request because Claude is answering it after asking its user (design 7.2). */
  acceptForReply(task: TaskRow, sessionId: string | null): void {
    if (task.approval !== 'pending') return;
    this.muted = true;
    try {
      this.node.accept(task.task_id, { sessionId: sessionId && this.cc.getSession(sessionId) ? sessionId : undefined, by: 'claude-code user (via a2a_reply)' });
    } finally {
      this.muted = false;
    }
  }

  // ---- digest -------------------------------------------------------------------

  /** "2 messages from dylan, 1 pending request; 1 open task you asked for." */
  digest(sessionId: string | null): string {
    const items = sessionId ? this.cc.unacked(sessionId) : this.cc.allUnacked();
    const byPeer = new Map<string, number>();
    let pending = 0;
    let updates = 0;
    for (const r of items) {
      if (r.kind === 'task_update') updates++;
      else if (r.kind === 'request' || r.kind === 'notify') pending++;
      else byPeer.set(r.peer ?? 'unknown', (byPeer.get(r.peer ?? 'unknown') ?? 0) + 1);
    }
    const bits: string[] = [];
    for (const [p, n] of byPeer) bits.push(`${n} message${n === 1 ? '' : 's'} from ${p}`);
    if (pending) bits.push(`${pending} request${pending === 1 ? '' : 's'} waiting for an answer`);
    if (updates) bits.push(`${updates} task update${updates === 1 ? '' : 's'}`);
    const openOut = this.node.store.listTasks({ direction: 'out', open: true, limit: 200 }).filter((t) => !sessionId || t.session_id === sessionId).length;
    const openIn = this.node.store.listTasks({ direction: 'in', open: true, limit: 200 }).length;
    const tasks: string[] = [];
    if (openOut) tasks.push(`${openOut} open task${openOut === 1 ? '' : 's'} you asked other agents for`);
    if (openIn) tasks.push(`${openIn} open task${openIn === 1 ? '' : 's'} other agents asked of you`);
    if (!bits.length && !tasks.length) return 'A2A: nothing new.';
    return `A2A: ${[bits.join(', '), tasks.join(', ')].filter(Boolean).join('; ')}.`;
  }

  /** New connection id for an MCP server process. */
  newConnId(): string {
    return randomUUID();
  }
}

/** What the MCP process turns into one `notifications/claude/channel`. */
export function itemEvent(row: InboxRow): { id: number; content: string; meta: Record<string, string> } {
  let meta: Record<string, string> = {};
  try {
    meta = row.meta_json ? (JSON.parse(row.meta_json) as Record<string, string>) : {};
  } catch {
    meta = {};
  }
  return { id: row.id, content: row.envelope, meta: { ...meta, item_id: String(row.id) } };
}
