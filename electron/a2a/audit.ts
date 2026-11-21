/**
 * Append-only JSONL audit log for A2A (design 4.2.7):
 * `~/.guycode/a2a/audit.jsonl`, one line per inbound and outbound message,
 * pairing event and state change.
 *
 * Never put tokens, invite secrets or pairing codes in an entry. `redact`
 * strips the obvious field names as a backstop, but callers should simply not
 * pass them. Message text IS logged (that is the point of the audit), capped
 * so a large message cannot balloon the file.
 *
 * Writes are synchronous appends: entries are small and rare (bounded by the
 * 60 req/min/peer limit), and an audit line that can be lost on a crash is
 * not much of an audit. Rotation is P5.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type AuditEvent =
  | 'inbound.message'
  | 'inbound.rejected'
  | 'inbound.duplicate'
  | 'outbound.message'
  | 'outbound.failed'
  | 'pair.invite'
  | 'pair.redeemed'
  | 'pair.accepted'
  | 'pair.rejected'
  | 'peer.revoked'
  | 'trust.changed'
  | 'trust.expired'
  | 'task.state'
  | 'task.approval'
  | 'task.reply'
  | 'outbound.queued'
  | 'outbound.expired'
  | 'push.sent'
  | 'push.failed'
  | 'push.dropped'
  | 'push.received'
  | 'push.ignored'
  | 'push.rejected'
  | 'poll.result'
  | 'wait.woke'
  | 'watch.started'
  | 'watch.check'
  | 'watch.met'
  | 'watch.woke'
  | 'watch.stopped'
  | 'peer.unpaired_by_remote'
  | 'server.started'
  | 'server.stopped';

export interface AuditEntry {
  event: AuditEvent;
  peer?: string;
  taskId?: string | null;
  contextId?: string | null;
  sessionId?: string | null;
  [k: string]: unknown;
}

const SECRET_KEYS = /token|secret|credential|authorization|password|pairingcode/i;
const MAX_TEXT = 4000;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (typeof v === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + `... [${v.length - MAX_TEXT} more chars]` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(x, depth + 1);
    return out;
  }
  return v;
}

export class AuditLog {
  constructor(private readonly path: string) {}

  write(entry: AuditEntry): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const line = JSON.stringify({ ts: new Date().toISOString(), ...(redact(entry) as object) });
      appendFileSync(this.path, line + '\n', 'utf8');
    } catch {
      // Auditing must never take the server down. The caller's own log line
      // (electron-log) still records the event.
    }
  }

  /** Newest-last tail, for the UI and tests. */
  tail(n = 200): Array<Record<string, unknown>> {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  }
}
