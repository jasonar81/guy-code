/**
 * Guy Code's router, pointed at Claude Code sessions.
 *
 * The A2ANode (shared with Guy Code) delivers inbound text through a
 * `SessionPort`: "start a turn", "interrupt a running turn", "queue behind a
 * wait". A Claude Code session cannot be driven like that from outside, so
 * every one of those calls lands in the same place: a row in `inbox`, which
 * the session's MCP channel pushes at once (if it is connected) and the
 * UserPromptSubmit hook re-surfaces until it is acked. That keeps the router,
 * the gate and the envelope exactly Guy Code's; only the last hop differs.
 *
 * `getOrCreateInboxSession` is design 7.2's "else hold in the inbox until a
 * session starts": it returns a placeholder id, and `add` stores the item
 * with routed_session NULL, which the next SessionStart claims.
 */
import { parseEnvelope, type RoutableSession, type SessionPort } from './shared/protocol';
import type { CcStore, InboxRow } from './inbox';

/** Placeholder session id for "no session yet: hold it" (design 7.2). */
export const HELD = '__a2a_held__';

export interface InboxSink {
  /** An item was stored; push it to the live channel, if any. */
  added(row: InboxRow): void;
}

/** Metadata the node gives us only through the envelope header, re-read for the channel meta. */
export function metaFromEnvelope(envelope: string, extra: Record<string, string> = {}): Record<string, string> {
  const p = parseEnvelope(envelope);
  // No envelope means the text is this runtime's own note (for example
  // "[A2A watch] ... is done"), never a peer's words: the node wraps every
  // piece of peer text in buildEnvelope before it reaches the port.
  if (!p) return { kind: 'runtime_note', ...extra };
  const kind = /This is a NOTIFY request/.test(envelope) ? 'notify' : /This is a REQUEST/.test(envelope) ? 'request' : 'inform';
  const meta: Record<string, string> = { kind };
  meta.from = p.peerId;
  meta.from_name = p.displayName;
  meta.agent = p.agentKindLabel;
  meta.trust = /^FULL/.test(p.trust) ? 'full' : p.trust;
  if (p.taskId) meta.task_id = p.taskId;
  if (p.contextId) meta.context_id = p.contextId;
  return { ...meta, ...extra };
}

export function ccSessionPort(store: CcStore, sink: InboxSink, muted: () => boolean = () => false): SessionPort {
  const add = (sessionId: string, text: string) => {
    // Muted while the daemon accepts a held request on Claude's own a2a_reply:
    // Claude is answering it, so re-delivering the same envelope would only
    // show it twice.
    if (muted()) return;
    const meta = metaFromEnvelope(text);
    const row = store.addItem({
      peer: meta.from ?? null,
      taskId: meta.task_id ?? null,
      contextId: meta.context_id ?? null,
      sessionId: sessionId === HELD ? null : sessionId,
      kind: meta.kind,
      envelope: text,
      meta,
    });
    sink.added(row);
  };
  const held: RoutableSession = {
    id: HELD,
    project_id: '',
    cwd: null,
    jsonl_path: '',
    jsonl_mtime: 0,
    state: 'idle',
    archived: 0,
    title: 'A2A inbox (held until a Claude Code session starts)',
    user_title: null,
  };
  return {
    listSessions: () => store.routable(),
    resolveSession: (rows, ref) => {
      const q = ref.trim().toLowerCase();
      if (!q) return { error: 'empty' };
      const exact = rows.filter((r) => r.id === ref || (r.user_title ?? '').toLowerCase() === q || (r.title ?? '').toLowerCase() === q);
      if (exact.length === 1) return { session: exact[0] };
      const fuzzy = rows.filter((r) => r.id.startsWith(ref) || (r.user_title || r.title || '').toLowerCase().includes(q));
      return fuzzy.length === 1 ? { session: fuzzy[0] } : { error: fuzzy.length ? 'ambiguous' : 'none' };
    },
    // Claude Code sessions are never "running" from our point of view: we
    // cannot interrupt them, so everything goes the same way.
    isRunning: () => false,
    queueInterrupt: (id, text) => add(id, text),
    startTurn: (s, text) => add(s.id, text),
    getOrCreateInboxSession: () => {
      // Most recently active registered session, else hold (design 7.2).
      const rows = store.routable();
      return rows[0] ?? held;
    },
    notify: () => {
      /* the daemon has no UI; the channel / hook surfaces everything */
    },
  };
}
