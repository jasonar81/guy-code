/**
 * Slack remote control ("drive Guy Code from your phone").
 *
 * When configured, this watches ONE Slack channel (typically your own DM with
 * yourself) and treats any message beginning with `Guy, ` as a command. Every
 * other message in that channel is ignored, so the channel stays usable for
 * normal chatter. Replies are posted as a thread on the command message.
 *
 * Transport: the EXISTING Slack MCP server (already OAuth'd for the user), via
 * invokeMcpTool. No bot token or Slack app setup needed.
 *
 * Off unless `slack_bridge.enabled` is set. Everything it can do is something
 * you can already do in the app - it is, by design, remote control of an agent,
 * which is why it is opt-in and scoped to a single channel you choose.
 */
import log from 'electron-log';
import { randomUUID } from 'node:crypto';
import { invokeMcpTool, reconnectMcpServer } from './mcp';
import { getClient } from './anthropic';
import {
  getSetting,
  setSetting,
  listSessionsAll,
  getSessionById,
  setSessionState,
  setSessionArchived,
  setSessionForceContinue,
  setSessionApiKey,
  upsertSession,
  upsertProject,
  type SessionFullRow,
} from './db';
import { listApiKeys, getDefaultApiKeyId } from './secret';
import { runUserTurn, queueInterrupt, cancelRun, isRunning } from './agent';
import { loadMessagesWithTsFromJsonl, ourJsonlPath } from './sessionRuntime';
import { broadcastStateChanged } from './agentEvents';

const PREFIX_RE = /^\s*guy\s*,\s*/i;
const DEFAULT_POLL_MS = 15_000;
const MIN_POLL_MS = 5_000;
/** Slack caps a text block; keep replies well under it. */
const MAX_REPLY_CHARS = 3500;

let _timer: NodeJS.Timeout | null = null;
let _polling = false;
/** Last Slack-MCP reconnect attempt, so we retry at most occasionally. */
let _lastReconnectAt = 0;
const RECONNECT_COOLDOWN_MS = 60_000;

// ---- settings ------------------------------------------------------------

export interface SlackBridgeConfig {
  enabled: boolean;
  channelId: string;
  pollMs: number;
}

export function getSlackBridgeConfig(): SlackBridgeConfig {
  const enabled = String(getSetting('slack_bridge.enabled') ?? '') === '1';
  const channelId = String(getSetting('slack_bridge.channel_id') ?? '').trim();
  const raw = Number(getSetting('slack_bridge.poll_ms'));
  const pollMs = Number.isFinite(raw) && raw >= MIN_POLL_MS ? raw : DEFAULT_POLL_MS;
  return { enabled, channelId, pollMs };
}

/** Cursor: the ts of the newest Slack message we've already handled. */
function getLastTs(): string {
  return String(getSetting('slack_bridge.last_ts') ?? '');
}
function setLastTs(ts: string) {
  setSetting('slack_bridge.last_ts', ts);
}

// ---- lifecycle -----------------------------------------------------------

/** (Re)start the watcher from current settings. Safe to call repeatedly. */
export function startSlackBridge(): void {
  stopSlackBridge();
  const cfg = getSlackBridgeConfig();
  if (!cfg.enabled || !cfg.channelId) {
    log.info('[slackBridge] disabled (or no channel configured)');
    return;
  }
  log.info(
    `[slackBridge] watching ${cfg.channelId} every ${cfg.pollMs}ms for "Guy, ..." commands`
  );
  _timer = setInterval(() => {
    void pollOnce();
  }, cfg.pollMs);
  // NOTE: deliberately NOT unref'd. This is a long-lived background service;
  // unref'ing it lets the timer stop firing, which is exactly what happened -
  // the very first poll hit "MCP server slack not connected" and the loop then
  // never ran again, so no command was ever picked up.
  // Kick immediately so a just-saved config responds without waiting a cycle.
  void pollOnce();
}

export function stopSlackBridge(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/**
 * Post a hello message to the configured channel so the user can confirm the
 * setup works (Settings -> "Send test message"). Returns a human-readable
 * result rather than throwing, so the UI can just show it.
 */
export async function testSlackBridge(): Promise<{ ok: boolean; message: string }> {
  const cfg = getSlackBridgeConfig();
  if (!cfg.channelId) return { ok: false, message: 'No channel id configured.' };
  try {
    const r = await invokeMcpTool('mcp__slack__slack_send_message', {
      channel_id: cfg.channelId,
      message:
        'Guy Code is connected. Send me commands starting with `Guy, ` — try `Guy, status` or `Guy, help`.',
    });
    if (!r) {
      return { ok: false, message: 'Slack MCP tool unavailable. Connect Slack in Settings first.' };
    }
    if (r.isError) return { ok: false, message: r.content || 'Slack rejected the message.' };
    return { ok: true, message: 'Sent. Check the channel on your phone.' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ---- Slack I/O -----------------------------------------------------------

async function slackRead(channelId: string, oldest: string): Promise<any[]> {
  const args: Record<string, unknown> = { channel_id: channelId, limit: 30 };
  // `oldest` is a Slack ts cursor; omit on the very first run.
  if (oldest) args.oldest = oldest;
  const r = await invokeMcpTool('mcp__slack__slack_read_channel', args);
  if (!r) throw new Error('Slack MCP tool not available');
  if (r.isError) throw new Error(r.content || 'slack_read_channel failed');
  return parseMessages(r.content);
}

/**
 * Normalize whatever `slack_read_channel` returned into `{ts, text, userId}`.
 *
 * The Slack MCP server does NOT return a messages array - it returns JSON whose
 * `messages` field is a formatted human-readable transcript, e.g.
 *
 *   {"messages":"Channel: DM (D3MC8RWSE)\n\n
 *     === Message from Jason Arnold <j@x.com> (U3LLWAJJU) at 2026-09-08 08:04:47 CDT ===\n
 *     Message TS: 1788872687.940679\n
 *     Guy, just testing\n\n
 *     === Message from ... ==="}
 *
 * (An earlier version of this function assumed an array and silently returned
 * nothing, so no command was ever seen.) We still accept a real array in case a
 * future server version returns one. Never throws.
 */
export function parseMessages(content: string): Array<{ ts: string; text: string; userId?: string }> {
  if (!content || !content.trim()) return [];
  let payload: unknown = content;
  try {
    const o: any = JSON.parse(content);
    // Already structured? Use it.
    const arr = Array.isArray(o) ? o : Array.isArray(o?.messages) ? o.messages : Array.isArray(o?.result?.messages) ? o.result.messages : null;
    if (arr) {
      return arr
        .filter((m: any) => m && typeof m.ts === 'string')
        .map((m: any) => ({ ts: m.ts, text: typeof m.text === 'string' ? m.text : '', userId: m.user }));
    }
    if (typeof o?.messages === 'string') payload = o.messages;
    else if (typeof o === 'string') payload = o;
  } catch {
    // not JSON - treat the whole thing as the transcript
  }
  return parseTranscript(String(payload));
}

/**
 * Parse the `=== Message from NAME <email> (UID) at TIME ===` / `Message TS: N`
 * transcript format into structured messages. The body is every line after the
 * TS line up to the next header.
 */
export function parseTranscript(text: string): Array<{ ts: string; text: string; userId?: string }> {
  const out: Array<{ ts: string; text: string; userId?: string }> = [];
  if (!text) return out;
  // Split on the header line, keeping the header so we can read the user id.
  const parts = text.split(/^===\s*Message from /m);
  for (const part of parts) {
    const tsM = part.match(/^Message TS:\s*([0-9.]+)\s*$/m);
    if (!tsM) continue;
    const uidM = part.match(/\(([UWB][A-Z0-9]+)\)/);
    // Body = everything after the "Message TS:" line.
    const idx = part.indexOf(tsM[0]);
    const body = part.slice(idx + tsM[0].length).replace(/^\s*\n/, '');
    out.push({
      ts: tsM[1],
      text: body.replace(/\s+$/, ''),
      userId: uidM ? uidM[1] : undefined,
    });
  }
  return out;
}

/**
 * Post a reply. Returns the ts of the message WE created when Slack tells us,
 * so we can recognise our own messages later - in a self-DM they come back
 * authored by the user, so 'who sent it' cannot distinguish us.
 */
async function slackPost(
  channelId: string,
  text: string,
  threadTs?: string
): Promise<string | null> {
  const message =
    text.length > MAX_REPLY_CHARS ? text.slice(0, MAX_REPLY_CHARS) + '\n...(truncated)' : text;
  const args: Record<string, unknown> = { channel_id: channelId, message };
  if (threadTs) args.thread_ts = threadTs;
  const r = await invokeMcpTool('mcp__slack__slack_send_message', args);
  if (r?.isError) {
    log.warn(`[slackBridge] reply failed: ${r.content}`);
    return null;
  }
  const m = (r?.content ?? '').match(/"?(?:message_)?ts"?\s*[:=]\s*"?(\d+\.\d+)"?/);
  return m ? m[1] : null;
}

/** Read one thread's replies, normalized like parseMessages. */
async function slackReadThread(
  channelId: string,
  threadTs: string
): Promise<Array<{ ts: string; text: string; userId?: string }>> {
  const r = await invokeMcpTool('mcp__slack__slack_read_thread', {
    channel_id: channelId,
    message_ts: threadTs,
    limit: 40,
  });
  if (!r) throw new Error('Slack MCP tool not available');
  if (r.isError) throw new Error(r.content || 'slack_read_thread failed');
  return parseMessages(r.content);
}

// ---- thread tracking -----------------------------------------------------
//
// We answer commands IN A THREAD. Anything the user then says in that thread is
// obviously meant for us, so it should NOT need the "Guy, " prefix and it
// should carry the conversation so far as context.
//
// Two things make this fiddly:
//   - In a self-DM OUR OWN replies come back authored by the user, so we track
//     the ts of everything we post and skip those rather than filtering by author.
//   - We can't watch threads forever: a thread with no activity for 24h is dropped.

interface ThreadState {
  /** Newest reply ts already handled in this thread. */
  cursor: string;
  /** Epoch ms of last activity (24h expiry). */
  touched: number;
  /** ts values WE posted - never treated as user input. */
  ours: string[];
}

const THREAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED_THREADS = 50;

export function loadThreads(): Record<string, ThreadState> {
  try {
    const raw = getSetting('slack_bridge.threads');
    if (!raw) return {};
    const o = JSON.parse(String(raw));
    return o && typeof o === 'object' ? (o as Record<string, ThreadState>) : {};
  } catch {
    return {};
  }
}

/** Persist, expiring threads idle >24h and capping the total. */
export function saveThreads(t: Record<string, ThreadState>, now = Date.now()) {
  const live = Object.entries(t)
    .filter(([, v]) => v && now - (v.touched ?? 0) < THREAD_TTL_MS)
    .sort((a, b) => (b[1].touched ?? 0) - (a[1].touched ?? 0))
    .slice(0, MAX_TRACKED_THREADS);
  setSetting('slack_bridge.threads', JSON.stringify(Object.fromEntries(live)));
}

/** Start or refresh tracking of the thread rooted at `threadTs`. */
export function rememberThread(threadTs: string, ourReplyTs?: string) {
  const t = loadThreads();
  const cur: ThreadState = t[threadTs] ?? { cursor: threadTs, touched: 0, ours: [] };
  cur.touched = Date.now();
  if (!cur.ours) cur.ours = [];
  if (ourReplyTs && !cur.ours.includes(ourReplyTs)) {
    cur.ours.push(ourReplyTs);
    if (cur.ours.length > 40) cur.ours = cur.ours.slice(-40);
  }
  t[threadTs] = cur;
  saveThreads(t);
}

/** Strip an optional leading "Guy," - inside a thread it isn't needed. */
export function stripPrefix(text: string): string {
  return (text || '').replace(PREFIX_RE, '');
}

/**
 * Answer new replies in threads we already participated in, without requiring
 * the prefix, passing the thread so far as conversation context.
 */
async function pollThreads(channelId: string): Promise<void> {
  const threads = loadThreads();
  const now = Date.now();
  for (const [threadTs, st] of Object.entries(threads)) {
    if (!st || now - (st.touched ?? 0) >= THREAD_TTL_MS) continue;
    let msgs: Array<{ ts: string; text: string; userId?: string }>;
    try {
      msgs = await slackReadThread(channelId, threadTs);
    } catch (e) {
      log.warn(`[slackBridge] thread ${threadTs} read failed: ${(e as Error).message}`);
      continue;
    }
    if (!msgs.length) continue;
    const ordered = msgs.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    const ours = st.ours ?? [];
    // Conversation so far: our posts are 'assistant', the rest are the user.
    const history = ordered.map((mm) => ({
      role: ours.includes(mm.ts) ? ('assistant' as const) : ('user' as const),
      text: stripPrefix(mm.text),
    }));

    let cursor = st.cursor || threadTs;
    for (let i = 0; i < ordered.length; i++) {
      const mm = ordered[i];
      if (Number(mm.ts) <= Number(cursor)) continue;
      if (ours.includes(mm.ts)) { cursor = mm.ts; continue; }
      const body = stripPrefix(mm.text).trim();
      if (!body) { cursor = mm.ts; continue; }
      log.info(`[slackBridge] thread follow-up: ${body.slice(0, 120)}`);
      let reply: string;
      try {
        reply = await handleCommand(body, true, history.slice(0, i));
      } catch (e) {
        reply = `Error: ${(e as Error).message}`;
        log.error('[slackBridge] thread command failed', e);
      }
      const postedTs = await slackPost(channelId, reply, threadTs);
      cursor = mm.ts;
      const t2 = loadThreads();
      const s2: ThreadState = t2[threadTs] ?? { cursor, touched: Date.now(), ours: [] };
      s2.cursor = cursor;
      s2.touched = Date.now();
      if (!s2.ours) s2.ours = [];
      if (postedTs && !s2.ours.includes(postedTs)) s2.ours.push(postedTs);
      t2[threadTs] = s2;
      saveThreads(t2);
    }
    if (cursor !== st.cursor) {
      const t3 = loadThreads();
      if (t3[threadTs]) {
        t3[threadTs].cursor = cursor;
        t3[threadTs].touched = Date.now();
        saveThreads(t3);
      }
    }
  }
}

// ---- the poll loop -------------------------------------------------------

async function pollOnce(): Promise<void> {
  if (_polling) return; // never overlap
  const cfg = getSlackBridgeConfig();
  if (!cfg.enabled || !cfg.channelId) return;
  _polling = true;
  try {
    const lastTs = getLastTs();
    const msgs = await slackRead(cfg.channelId, lastTs);
    // Oldest first so commands run in the order they were sent, and so the
    // cursor advances monotonically.
    const ordered = msgs
      .filter((m) => typeof m?.ts === 'string')
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    log.info(
      `[slackBridge] poll ok: ${ordered.length} message(s) since ${lastTs || '(start)'}`
    );
    // FIRST RUN (no cursor): don't replay the channel's history - just take the
    // newest message as the starting point. Otherwise enabling the bridge would
    // execute every old "Guy, ..." message in the DM.
    if (!lastTs) {
      const newest = ordered[ordered.length - 1];
      if (newest) {
        setLastTs(newest.ts);
        log.info(`[slackBridge] first run - starting from ts ${newest.ts} (history skipped)`);
      }
      return;
    }
    for (const m of ordered) {
      const ts: string = m.ts;
      if (lastTs && Number(ts) <= Number(lastTs)) continue;
      const text: string = typeof m.text === 'string' ? m.text : '';
      // Only messages addressed to us. Our own replies never start with
      // "Guy," so this also prevents feedback loops.
      if (!PREFIX_RE.test(text)) {
        setLastTs(ts);
        continue;
      }
      const command = text.replace(PREFIX_RE, '').trim();
      log.info(`[slackBridge] command: ${command.slice(0, 120)}`);
      let reply: string;
      try {
        reply = await handleCommand(command);
      } catch (e) {
        reply = `Error: ${(e as Error).message}`;
        log.error('[slackBridge] command failed', e);
      }
      const postedTs = await slackPost(cfg.channelId, reply, ts);
      // Track this thread so follow-ups need no prefix, recording our own
      // reply so we never read it back as user input.
      rememberThread(ts, postedTs ?? undefined);
      setLastTs(ts);
    }
    // Follow-ups inside threads we already answered (no prefix needed).
    await pollThreads(cfg.channelId);
  } catch (e) {
    const msg = (e as Error).message || '';
    log.warn(`[slackBridge] poll failed: ${msg}`);
    // If the Slack MCP server is dead (it can time out during startup and then
    // stays dead forever), ask for a reconnect instead of polling a corpse on
    // every tick. Rate-limited so a permanently-broken server doesn't get
    // hammered - and reported once so the user can see it in Slack terms.
    if (/not connected|not available/i.test(msg)) {
      const now = Date.now();
      if (now - _lastReconnectAt > RECONNECT_COOLDOWN_MS) {
        _lastReconnectAt = now;
        log.info('[slackBridge] attempting Slack MCP reconnect');
        const ok = await reconnectMcpServer('slack').catch(() => false);
        log.info(`[slackBridge] reconnect ${ok ? 'succeeded' : 'failed'}`);
        if (ok) {
          // Try the poll again right away so a command isn't delayed a cycle.
          _polling = false;
          return pollOnce();
        }
      }
    }
  } finally {
    _polling = false;
  }
}

// ---- command handling ----------------------------------------------------

const HELP = [
  'Commands (prefix each with `Guy, `):',
  '• `status` - counts + every non-archived session',
  '• `active` / `running` / `idle` / `needs you` - filtered list',
  '• `output <session> [since 30m|<epoch-ms>]` - recent transcript',
  '• `send <session> <text>` - send input to a session',
  '• `new session <name>` - create one',
  '• `idle <session>` - stop/park it',
  '• `force continue <session> on|off`',
  '• `api key <session> <key name>`',
  '• `archive <session>`',
  '• `api keys` - list your API keys',
  '• `unarchive <session>`',
  '• `help`',
  '',
  '`<session>` can be a name (or part of one) or an id prefix.',
  '',
  "You don't need this exact syntax - plain English works too, e.g.",
  '“which sessions need me?” or “what API keys do I have?”',
  '',
  'And in a thread I started, just reply normally - no “Guy,” needed, and I',
  'keep the conversation so you can say “now tell the other one that too”.',
].join('\n');

const NEEDS_YOU = new Set(['waiting-on-user', 'error']);
const RUNNING = new Set(['running', 'waiting-on-system', 'sleeping-tool', 'sleeping-budget']);

function label(s: SessionFullRow): string {
  return (s.user_title || s.title || '(untitled)').replace(/\s+/g, ' ').trim();
}
function line(s: SessionFullRow): string {
  return `• ${label(s)} — ${s.state} \`${s.id.slice(0, 8)}\``;
}

/**
 * Resolve a user-typed session reference: an id prefix, or a case-insensitive
 * substring of the name. Prefers non-archived matches (that's what you mean
 * from a phone), and reports ambiguity instead of guessing.
 */
export function resolveSession(
  rows: SessionFullRow[],
  ref: string
): { session?: SessionFullRow; error?: string } {
  let q = ref.trim().toLowerCase();
  if (!q) return { error: 'Which session? Give a name or id prefix.' };
  // Strip the filler people naturally type around a name: "the flood
  // session", "session 4cf5acb3", quotes, "that's waiting on me". Without
  // this, "tell the flood session to continue" resolved the ref "the" and
  // matched dozens of sessions.
  q = q
    .replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '')
    .replace(/^(?:the|a)\s+/, '')
    .replace(/^session\s+/, '')
    .replace(/\s+session$/, '')
    .replace(/\s+that'?s?\s+waiting[\s\S]*$/, '')
    .replace(/\s+which\s+is\s+[\s\S]*$/, '')
    .trim();
  if (!q) return { error: 'Which session? Give a name or id prefix.' };

  const byId = rows.filter((x) => x.id.toLowerCase().startsWith(q));
  if (byId.length === 1) return { session: byId[0] };

  // RANK name matches so a clearly-better match WINS instead of us reporting
  // ambiguity: exact > starts-with > word-start > substring, with a nudge for
  // live sessions and ones needing attention. This is what left "Marvin fixes"
  // permanently ambiguous against "BALD/MARVIN Testing".
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
  const scored = rows
    .map((x) => {
      const name = label(x).toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (new RegExp("\\b" + esc).test(name)) score = 60;
      else if (name.includes(q)) score = 40;
      if (score > 0) {
        if (x.archived === 0) score += 5;
        if (NEEDS_YOU.has(x.state)) score += 3;
      }
      return { x, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || (scored.length > 1 && scored[0].score > scored[1].score)) {
    return { session: scored[0].x };
  }
  let cands = scored.length ? scored.map((e) => e.x) : byId;
  if (cands.length === 0) return { error: `No session matches "${ref}".` };
  if (cands.length > 1) {
    const live = cands.filter((s) => s.archived === 0);
    if (live.length >= 1) cands = live;
  }
  if (cands.length === 0) return { error: `No session matches "${ref}".` };
  if (cands.length > 1) {
    return {
      error:
        `"${ref}" matches ${cands.length} sessions:\n` +
        cands.slice(0, 8).map(line).join('\n') +
        '\nBe more specific (or use the id prefix).',
    };
  }
  return { session: cands[0] };
}

/**
 * Match `send|tell|reply <session> <text>` where <session> may be MULTI-WORD.
 * Walks split points from the longest session ref down and takes the first
 * that resolves to exactly one session; falls back to the first word so the
 * caller still yields a sensible not-found/ambiguous message.
 */
export function matchSendCommand(
  cmd: string,
  rows: SessionFullRow[]
): [string, string, string] | null {
  const head = cmd.match(/^(?:send|tell|reply)\s+([\s\S]+)$/i);
  if (!head) return null;
  const words = head[1].trim().split(/\s+/);
  for (let n = Math.min(words.length - 1, 8); n >= 1; n--) {
    const ref = words.slice(0, n).join(' ');
    const text = words.slice(n).join(' ');
    if (!text.trim()) continue;
    if (resolveSession(rows, ref).session) return ['', ref, text];
  }
  if (words.length >= 2) return ['', words[0], words.slice(1).join(' ')];
  return null;
}

/** Parse `since 30m` / `since 2h` / `since <epoch-ms>` -> epoch ms. */
export function parseSince(text: string): number | null {
  const m = text.match(/since\s+(\d+)\s*(ms|s|m|h|d)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  if (!unit) return n > 1e11 ? n : Date.now() - n * 60_000; // bare big number = epoch
  const mult =
    unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Date.now() - n * mult;
}

/**
 * Run one command. Terse syntax (`status`, `send X hi`) is matched by regex -
 * free and instant. Anything else is handed to a cheap model that rewrites it
 * into terse syntax and we re-run that; `allowInterpret` stops recursion.
 */
export async function handleCommand(
  command: string,
  allowInterpret = true,
  threadHistory?: Array<{ role: 'user' | 'assistant'; text: string }>
): Promise<string> {
  const cmd = command.trim();
  const lower = cmd.toLowerCase();
  if (!cmd || lower === 'help' || lower === '?') return HELP;

  const rows = listSessionsAll();
  const live = rows.filter((s) => s.archived === 0);

  // ---- status / lists ----
  if (lower === 'status' || lower === 'sessions' || lower === 'list') {
    const needs = live.filter((s) => NEEDS_YOU.has(s.state));
    const running = live.filter((s) => RUNNING.has(s.state));
    const idle = live.filter((s) => s.state === 'idle');
    const head = `${live.length} sessions — ${needs.length} need you, ${running.length} running, ${idle.length} idle`;
    const body = [
      needs.length ? '*Needs you*\n' + needs.map(line).join('\n') : '',
      running.length ? '*Running*\n' + running.map(line).join('\n') : '',
      idle.length ? '*Idle*\n' + idle.map(line).join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return `${head}\n\n${body}`.trim();
  }
  if (lower === 'needs you' || lower === 'needsyou' || lower === 'needs-you') {
    const l = live.filter((s) => NEEDS_YOU.has(s.state));
    return l.length ? `${l.length} need you:\n` + l.map(line).join('\n') : 'Nothing needs you.';
  }
  if (lower === 'running' || lower === 'active') {
    const l = live.filter((s) => RUNNING.has(s.state));
    return l.length ? `${l.length} running:\n` + l.map(line).join('\n') : 'Nothing is running.';
  }
  if (lower === 'idle') {
    const l = live.filter((s) => s.state === 'idle');
    return l.length ? `${l.length} idle:\n` + l.map(line).join('\n') : 'No idle sessions.';
  }

  // ---- api keys (list) ----
  if (/^(?:api\s*keys?|keys)$/i.test(lower) || /^list\s+(?:api\s*)?keys$/i.test(lower)) {
    const keys = listApiKeys();
    if (!keys.length) return 'No API keys configured.';
    const def = getDefaultApiKeyId();
    return (
      `${keys.length} API key${keys.length === 1 ? '' : 's'}:\n` +
      keys
        .map((k: any) => `• ${k.name}${k.id === def ? '  _(default)_' : ''}`)
        .join('\n')
    );
  }

  // ---- unarchive <session> ----
  let m = cmd.match(/^unarchive\s+(.+)$/i) || cmd.match(/^restore\s+(.+)$/i);
  if (m) {
    const { session, error } = resolveSession(rows, m[1]);
    if (error) return error;
    setSessionArchived(session!.id, false);
    return `Restored *${label(session!)}* from the archive.`;
  }

  // ---- new session <name> ----
  m = cmd.match(/^new\s+session\s+(.+)$/i) || cmd.match(/^new\s+(.+)$/i);
  if (m) {
    const name = m[1].trim();
    const id = randomUUID();
    // Mirrors the app's own sessions:create (ipc.ts): no cwd binding means the
    // shared synthetic project, and we bind the default api key so the session
    // is immediately usable.
    const projectId = '__guy_default__';
    upsertProject({ id: projectId, cwd: '', lastActivityTs: Date.now(), createdAt: Date.now() });
    upsertSession({
      id,
      projectId,
      jsonlPath: ourJsonlPath(id),
      jsonlMtime: Date.now(),
      jsonlSize: 0,
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 0,
      lastMessagePreview: null,
      title: name,
    });
    setSessionState(id, 'idle');
    const defKey = getDefaultApiKeyId();
    if (defKey) setSessionApiKey(id, defKey);
    broadcastStateChanged(id, 'idle');
    return `Created *${name}* \`${id.slice(0, 8)}\`. Send it work with:\n\`Guy, send ${name} <your message>\``;
  }

  // ---- output <session> [since ...] ----
  m = cmd.match(/^output\s+(.+)$/i) || cmd.match(/^show\s+(.+)$/i);
  if (m) {
    let ref = m[1].trim();
    const since = parseSince(ref);
    ref = ref.replace(/\s*since\s+\d+\s*(ms|s|m|h|d)?\s*$/i, '').trim();
    const { session, error } = resolveSession(rows, ref);
    if (error) return error;
    const msgs = loadMessagesWithTsFromJsonl(session!.jsonl_path) ?? [];
    const cutoff = since ?? 0;
    const recent = msgs.filter((x: any) => !cutoff || (x.ts ?? 0) >= cutoff);
    const pick = recent.slice(-12);
    if (!pick.length) {
      return `*${label(session!)}* (${session!.state}) — nothing${since ? ' since then' : ''}.`;
    }
    const body = pick
      .map((x: any) => {
        const who = x.role === 'user' ? 'you' : 'guy';
        const text = extractText(x).replace(/\s+/g, ' ').trim();
        return text ? `*${who}:* ${text.slice(0, 400)}` : null;
      })
      .filter(Boolean)
      .join('\n');
    return `*${label(session!)}* (${session!.state})\n${body}`;
  }

  // ---- send <session> <text> ----
  // The session may be MULTI-WORD ('small tables 2'), so find the split that
  // actually resolves. A bare (\\S+) here is what made
  // "tell the flood session to continue" target a session called "the".
  m = matchSendCommand(cmd, rows);
  if (m) {
    const { session, error } = resolveSession(rows, m[1]);
    if (error) return error;
    const text = m[2].trim();
    const s = session!;
    if (isRunning(s.id)) {
      queueInterrupt(s.id, text);
      return `Queued for *${label(s)}* (it's mid-turn; it'll pick this up shortly).`;
    }
    // Fire and forget - a turn can run for a long time; we reply immediately.
    void runUserTurn({
      sessionId: s.id,
      projectId: s.project_id,
      cwd: s.cwd ?? '',
      userText: text,
      continueExisting: true,
      seedFromJsonl: s.jsonl_path,
    }).catch((e) => log.error('[slackBridge] runUserTurn failed', e));
    return `Sent to *${label(s)}*. Ask for \`output ${label(s)}\` in a bit.`;
  }

  // ---- idle <session> ----
  m = cmd.match(/^(?:idle|stop|park)\s+(.+)$/i);
  if (m) {
    const { session, error } = resolveSession(rows, m[1]);
    if (error) return error;
    try {
      cancelRun(session!.id);
    } catch {
      /* not running - fine */
    }
    setSessionState(session!.id, 'idle');
    // Push the state change to the open app window so the sidebar updates
    // live when you park a session from your phone.
    broadcastStateChanged(session!.id, 'idle');
    return `*${label(session!)}* is now idle.`;
  }

  // ---- force continue <session> on|off ----
  m = cmd.match(/^force\s*continue\s+(.+?)\s+(on|off|true|false|yes|no)$/i);
  if (m) {
    const { session, error } = resolveSession(rows, m[1]);
    if (error) return error;
    const on = /^(on|true|yes)$/i.test(m[2]);
    setSessionForceContinue(session!.id, on);
    return `Force continue ${on ? 'ON' : 'off'} for *${label(session!)}*.`;
  }

  // ---- api key <session> <key name> ----
  m = cmd.match(/^api\s*key\s+(\S+)\s+(.+)$/i);
  if (m) {
    const { session, error } = resolveSession(rows, m[1]);
    if (error) return error;
    const wanted = m[2].trim().toLowerCase();
    const keys = listApiKeys();
    const key = keys.find(
      (k: any) => String(k.name ?? '').toLowerCase() === wanted ||
        String(k.name ?? '').toLowerCase().includes(wanted)
    );
    if (!key) {
      return `No API key matches "${m[2].trim()}". Have: ${keys.map((k: any) => k.name).join(', ') || '(none)'}`;
    }
    setSessionApiKey(session!.id, (key as any).id);
    return `*${label(session!)}* now uses API key *${(key as any).name}*.`;
  }

  // ---- archive <session> ----
  m = cmd.match(/^archive\s+(.+)$/i);
  if (m) {
    const { session, error } = resolveSession(rows, m[1]);
    if (error) return error;
    setSessionArchived(session!.id, true);
    return `Archived *${label(session!)}*.`;
  }

  // ---- nothing matched the terse syntax: interpret it as plain English ----
  // Everything above is a free, instant regex match. Anything else (a real
  // sentence like "can you tell me which sessions need me?") goes to a cheap
  // model that translates it into one of the commands above, which we then run.
  if (!allowInterpret) {
    return `Didn't understand "${cmd}". Try: Guy, help`;
  }
  const it = await interpretCommand(cmd, rows, threadHistory);
  // A STRUCTURED action is executed directly - no re-parsing, so a multi-word
  // name or a pronoun cannot be mangled on the way through (which is how
  // "the Marvin fixes session" used to degrade into an unresolvable "Marvin").
  if (it.action) {
    log.info(`[slackBridge] interpreted as action=${it.action}`);
    return executeInterpreted(it, rows);
  }
  if (it.command) return handleCommand(it.command, false, threadHistory);
  if (it.reply) return it.reply;
  return `Not sure what you meant by "${cmd}". Try: Guy, help`;
}

/** Execute a structured Interpretation. */
async function executeInterpreted(
  it: Interpretation,
  rows: SessionFullRow[]
): Promise<string> {
  const pick = (): { session?: SessionFullRow; error?: string } => {
    if (!it.sessionId) return { error: 'Which session did you mean?' };
    const want = it.sessionId.toLowerCase();
    const exact = rows.find((x) => x.id.toLowerCase().startsWith(want));
    if (exact) return { session: exact };
    return resolveSession(rows, it.sessionId);
  };
  const idOf = (x: SessionFullRow) => x.id.slice(0, 8);
  switch (it.action) {
    case 'status': return handleCommand('status', false);
    case 'needs_you': return handleCommand('needs you', false);
    case 'running': return handleCommand('running', false);
    case 'idle_list': return handleCommand('idle', false);
    case 'api_keys': return handleCommand('api keys', false);
    case 'help': return HELP;
    case 'reply': return it.reply || 'Not sure what you meant. Try `Guy, help`.';
    case 'output': {
      const { session, error } = pick();
      if (error) return error;
      const mins = it.sinceMinutes ? ` since ${it.sinceMinutes}m` : '';
      return handleCommand(`output ${idOf(session!)}${mins}`, false);
    }
    case 'send': {
      const { session, error } = pick();
      if (error) return error;
      if (!it.text || !it.text.trim()) return `What should I send to *${label(session!)}*?`;
      return handleCommand(`send ${idOf(session!)} ${it.text.trim()}`, false);
    }
    case 'new_session': {
      if (!it.text || !it.text.trim()) return 'What should the new session be called?';
      return handleCommand(`new session ${it.text.trim()}`, false);
    }
    case 'make_idle': {
      const { session, error } = pick();
      if (error) return error;
      return handleCommand(`idle ${idOf(session!)}`, false);
    }
    case 'force_continue': {
      const { session, error } = pick();
      if (error) return error;
      return handleCommand(`force continue ${idOf(session!)} ${it.on ? 'on' : 'off'}`, false);
    }
    case 'set_api_key': {
      const { session, error } = pick();
      if (error) return error;
      if (!it.text || !it.text.trim()) return 'Which API key?';
      return handleCommand(`api key ${idOf(session!)} ${it.text.trim()}`, false);
    }
    case 'archive': {
      const { session, error } = pick();
      if (error) return error;
      return handleCommand(`archive ${idOf(session!)}`, false);
    }
    case 'unarchive': {
      const { session, error } = pick();
      if (error) return error;
      return handleCommand(`unarchive ${idOf(session!)}`, false);
    }
    default:
      return it.reply || 'Not sure what you meant. Try `Guy, help`.';
  }
}

/** Cheap model used to interpret plain English. */
const INTERPRETER_MODEL = 'claude-haiku-4-5';

/** A structured action the interpreter can ask for. */
export interface Interpretation {
  action?:
    | 'status' | 'needs_you' | 'running' | 'idle_list' | 'api_keys'
    | 'output' | 'send' | 'new_session' | 'make_idle' | 'force_continue'
    | 'set_api_key' | 'archive' | 'unarchive' | 'help' | 'reply';
  /** EXACT session id the action targets. */
  sessionId?: string;
  /** Message to send / new session name / api key name. */
  text?: string;
  sinceMinutes?: number;
  on?: boolean;
  reply?: string;
  /** Legacy: a terse command string. */
  command?: string;
}

/**
 * Interpret plain English into a STRUCTURED action.
 *
 * Structured rather than 'rewrite as a terse command' because the old version
 * emitted a command string that went back through the regex parser and lost
 * information at every hop: 'tell the flood session to continue' became
 * `send the flood ...` (session 'the'), and 'the Marvin fixes session' became
 * `output Marvin` which stayed ambiguous forever. The model now picks an EXACT
 * id from a list that includes ids.
 *
 * `threadHistory` carries the conversation when the user is replying in a
 * thread, so follow-ups like 'now send that to the other one' work.
 *
 * Cheap model, DEFAULT api key, only reached when the terse path missed.
 */
export async function interpretCommand(
  text: string,
  rows: SessionFullRow[],
  threadHistory?: Array<{ role: 'user' | 'assistant'; text: string }>
): Promise<Interpretation> {
  const live = rows.filter((x) => x.archived === 0);
  const listing = live
    .slice(0, 80)
    .map(
      (x) =>
        `- id=${x.id.slice(0, 8)} name="${label(x)}" state=${x.state}` +
        (NEEDS_YOU.has(x.state) ? ' (needs you)' : '')
    )
    .join('\n');

  const system = [
    'You are the command interpreter for Guy Code, which manages many coding-agent sessions.',
    'The user talks to you from Slack, usually on a phone, in casual English.',
    'Reply with ONLY a JSON object. No prose, no code fences.',
    '',
    'Shape: {"action":"<action>", ...fields}',
    '  status                                 counts + all live sessions',
    '  needs_you                              sessions waiting on the user',
    '  running                                sessions currently working',
    '  idle_list                              idle sessions',
    '  api_keys                               list configured API keys',
    '  output      {sessionId, sinceMinutes?} recent transcript',
    '  send        {sessionId, text}          send input to a session',
    '  new_session {text}                     create a session named text',
    '  make_idle   {sessionId}                stop/park a session',
    '  force_continue {sessionId, on}         toggle force-continue',
    '  set_api_key {sessionId, text}          switch to the named key',
    '  archive     {sessionId}                archive a session',
    '  unarchive   {sessionId}                restore a session',
    '  help                                   list what you can do',
    '  reply       {reply}                    you cannot act; answer briefly',
    '',
    'CRITICAL: when an action needs a session, set sessionId to the EXACT 8-character',
    'id from the list below. NEVER echo the user words as the session.',
    'If a reference is loose but one candidate clearly fits (it is the one needing',
    'attention, or its name matches more closely), PICK IT instead of asking.',
    'Only use action reply to ask for clarification if candidates are truly equal.',
    '',
    'If the user asks something you cannot know from a transcript ("did it write a',
    'file?", "what path did it use?"), the useful move is action send to ASK THAT',
    'SESSION, or output to show its recent transcript. Prefer acting over refusing.',
    'Keep reply text short - it is read on a phone. Never dump the command list.',
    '',
    'Sessions:',
    listing || '(none)',
  ].join('\n');

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const h of (threadHistory ?? []).slice(-12)) {
    if (h.text && h.text.trim()) messages.push({ role: h.role, content: h.text.slice(0, 1500) });
  }
  messages.push({ role: 'user', content: text.slice(0, 2000) });

  try {
    const client = getClient(getDefaultApiKeyId());
    const resp = await client.messages.create({
      model: INTERPRETER_MODEL,
      max_tokens: 500,
      system,
      messages,
    });
    const raw = (resp.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();
    return parseInterpretation(raw) ?? {};
  } catch (e) {
    log.warn(`[slackBridge] interpret failed: ${(e as Error).message}`);
    return {};
  }
}

/** Pull the JSON object out of a model reply (tolerates fences / prose). */
export function parseInterpretation(raw: string): Interpretation | null {
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const out: Interpretation = {};
    if (typeof o.action === 'string') out.action = o.action.trim() as Interpretation['action'];
    if (typeof o.sessionId === 'string') out.sessionId = o.sessionId.trim();
    if (typeof o.text === 'string') out.text = o.text;
    if (typeof o.reply === 'string') out.reply = o.reply.trim();
    if (typeof o.on === 'boolean') out.on = o.on;
    if (typeof o.command === 'string' && o.command.trim()) out.command = o.command.trim();
    const sm = Number(o.sinceMinutes);
    if (Number.isFinite(sm) && sm > 0) out.sinceMinutes = sm;
    if (!out.action && !out.reply && !out.command) return null;
    return out;
  } catch {
    return null;
  }
}

/** Best-effort text extraction from a stored message record. */
function extractText(msg: any): string {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b: any) => {
        if (b?.type === 'text') return b.text ?? '';
        if (b?.type === 'tool_use') return `[${b.name}]`;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}
