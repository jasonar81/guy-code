/**
 * Push notifications and the offline outbox: the pure parts (design 5.3, 6.6).
 *
 * The node (node.ts) owns the I/O; this file owns the decisions, so they can
 * be tested without sockets:
 *   - when to retry a failed delivery, and when to give up;
 *   - what a push body looks like;
 *   - whether an inbound push may change a task we created (never reopen a
 *     terminal task, never move backwards, drop stale or duplicate snapshots).
 *
 * Retry schedule. A push is retried 5 times with exponential backoff, 2s up
 * to 2 minutes. After that, a push that reports a TERMINAL state keeps being
 * retried hourly for 24 hours (that is the "test is done" news the other side
 * is sleeping on); a non-terminal one is dropped, because the requester's
 * 10-minute poll backstop will pick the state up anyway. A queued SendMessage
 * (peer offline) is retried every 5 minutes for 24 hours after the fast
 * retries: the user was told "queued, will retry for 24h", and hourly would
 * make "delivered when they come back" feel broken. Any authenticated request
 * from that peer also makes their queue due immediately (node.ts).
 *
 * Why the push carries no credentials from the requester. Design 5.3 has the
 * requester put its own bearer token in `authentication.credentials`. We do
 * not: both sides already hold a per-peer token for calling each other, and a
 * push is just "the peer calling us", so the receiver presents the token it
 * already has, over the pinned TLS socket. Sending a bearer token inside a
 * JSON body only adds a place for it to leak (logs, audit, a third party that
 * relays the config). The per-task `token` is still sent and checked, which is
 * what ties a push to the one task it is about (design 4.2.5).
 */
// TODO(P4): the Claude Code daemon needs exactly these rules (retry schedule,
// judgeSnapshot, readStreamResponse). This file and waiters.ts import nothing
// but ./types, so they can be vendored or moved into the shared package (Q6).
import { TERMINAL_STATES, type Artifact, type Message, type StreamResponse, type Task, type TaskState } from './types';

export const RETRY = {
  fastDelaysMs: [2_000, 8_000, 30_000, 120_000, 120_000] as readonly number[],
  terminalPushEveryMs: 60 * 60_000,
  sendEveryMs: 5 * 60_000,
  windowMs: 24 * 60 * 60_000,
} as const;

/**
 * When to try again after `failures` failed attempts (1 = the first one
 * failed), or null to give up. Never schedules past `expiresTs`.
 */
export function nextRetryTs(kind: 'push' | 'send', terminal: boolean, failures: number, now: number, expiresTs: number): number | null {
  let delay: number | null;
  if (failures <= RETRY.fastDelaysMs.length) delay = RETRY.fastDelaysMs[failures - 1] ?? RETRY.fastDelaysMs[0];
  else if (kind === 'send') delay = RETRY.sendEveryMs;
  else delay = terminal ? RETRY.terminalPushEveryMs : null;
  if (delay === null) return null;
  const at = now + delay;
  return at > expiresTs ? null : at;
}

/** Ordering used to refuse a push that would move a task backwards. */
function rank(s: TaskState): number {
  if (TERMINAL_STATES.has(s)) return 2;
  if (s === 'TASK_STATE_SUBMITTED' || s === 'TASK_STATE_UNSPECIFIED') return 0;
  return 1; // WORKING, INPUT_REQUIRED, AUTH_REQUIRED move freely between each other
}

const VALID_STATES: ReadonlySet<string> = new Set<TaskState>([
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export function isTaskState(v: unknown): v is TaskState {
  return typeof v === 'string' && VALID_STATES.has(v);
}

export type ApplyVerdict = 'apply' | 'terminal' | 'backwards' | 'stale' | 'duplicate';

/**
 * Decide whether a snapshot from the peer may replace what we have. Pure, so
 * the replay rules (design 4.2.5) are tested in isolation.
 */
export function judgeSnapshot(
  cur: { state: TaskState; statusTs?: string | null; statusMessageId?: string | null; artifactsCount?: number },
  next: { state: TaskState; statusTs?: string | null; statusMessageId?: string | null; artifactsCount?: number }
): ApplyVerdict {
  if (TERMINAL_STATES.has(cur.state)) return 'terminal';
  if (rank(next.state) < rank(cur.state)) return 'backwards';
  const a = cur.statusTs ? Date.parse(cur.statusTs) : NaN;
  const b = next.statusTs ? Date.parse(next.statusTs) : NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && b < a) return 'stale';
  if (
    next.state === cur.state &&
    (next.statusTs ?? null) === (cur.statusTs ?? null) &&
    (next.statusMessageId ?? null) === (cur.statusMessageId ?? null) &&
    (next.artifactsCount ?? 0) === (cur.artifactsCount ?? 0)
  ) {
    return 'duplicate';
  }
  return 'apply';
}

/** Normalise any of the four StreamResponse shapes to (taskId, snapshot or message). */
export function readStreamResponse(body: StreamResponse): {
  taskId: string;
  contextId?: string;
  task?: Partial<Task> & { status: Task['status'] };
  message?: Message;
  artifact?: Artifact;
} | null {
  if (!body || typeof body !== 'object') return null;
  const set = ['task', 'message', 'statusUpdate', 'artifactUpdate'].filter((k) => (body as Record<string, unknown>)[k] !== undefined);
  if (set.length !== 1) return null; // proto oneof: exactly one
  if (body.task && typeof body.task.id === 'string' && body.task.status) {
    return { taskId: body.task.id, contextId: body.task.contextId, task: body.task };
  }
  if (body.statusUpdate && typeof body.statusUpdate.taskId === 'string' && body.statusUpdate.status) {
    return { taskId: body.statusUpdate.taskId, contextId: body.statusUpdate.contextId, task: { status: body.statusUpdate.status } };
  }
  if (body.artifactUpdate && typeof body.artifactUpdate.taskId === 'string' && body.artifactUpdate.artifact) {
    return { taskId: body.artifactUpdate.taskId, contextId: body.artifactUpdate.contextId, artifact: body.artifactUpdate.artifact };
  }
  if (body.message && typeof body.message.taskId === 'string' && typeof body.message.messageId === 'string') {
    return { taskId: body.message.taskId, contextId: body.message.contextId, message: body.message };
  }
  return null;
}

/** Flatten parts to text for notes and the UI (data parts as compact JSON). */
export function partsText(parts: Array<{ text?: string; data?: unknown }> | undefined, max = 4000): string {
  const s = (parts ?? [])
    .map((p) => (typeof p.text === 'string' ? p.text : p.data !== undefined ? JSON.stringify(p.data) : ''))
    .filter(Boolean)
    .join('\n');
  return s.length > max ? s.slice(0, max) + `... [${s.length - max} more chars]` : s;
}

/** Status message text plus every artifact's text. */
export function taskOutcomeText(task: { status?: { message?: Message }; artifacts?: Artifact[] }, max = 4000): string {
  const bits: string[] = [];
  const sm = partsText(task.status?.message?.parts, max);
  if (sm) bits.push(sm);
  for (const a of task.artifacts ?? []) {
    const t = partsText(a.parts, max);
    if (t) bits.push(a.name ? `${a.name}: ${t}` : t);
  }
  const s = bits.join('\n');
  return s.length > max ? s.slice(0, max) + '...' : s;
}

/** Metadata key marking an INPUT_REQUIRED that only means "waiting for the user to approve". */
export const APPROVAL_METADATA_KEY = 'ocient.approval';

export function isApprovalPendingStatus(status: { state?: TaskState; message?: Message } | undefined | null): boolean {
  return status?.state === 'TASK_STATE_INPUT_REQUIRED' && status?.message?.metadata?.[APPROVAL_METADATA_KEY] === 'pending';
}
