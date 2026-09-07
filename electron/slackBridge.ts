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
import { invokeMcpTool } from './mcp';
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
  _timer.unref?.();
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
 * The MCP tool returns text. Usually that's JSON with a `messages` array, but
 * be defensive: different server versions shape this differently, and a parse
 * failure must not kill the loop.
 */
export function parseMessages(content: string): any[] {
  if (!content || !content.trim()) return [];
  try {
    const o = JSON.parse(content);
    if (Array.isArray(o)) return o;
    if (Array.isArray(o?.messages)) return o.messages;
    if (Array.isArray(o?.result?.messages)) return o.result.messages;
    return [];
  } catch {
    return [];
  }
}

async function slackPost(channelId: string, text: string, threadTs?: string) {
  const message = text.length > MAX_REPLY_CHARS
    ? text.slice(0, MAX_REPLY_CHARS) + '\n…(truncated)'
    : text;
  const args: Record<string, unknown> = { channel_id: channelId, message };
  if (threadTs) args.thread_ts = threadTs;
  const r = await invokeMcpTool('mcp__slack__slack_send_message', args);
  if (r?.isError) log.warn(`[slackBridge] reply failed: ${r.content}`);
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
      await slackPost(cfg.channelId, reply, ts);
      setLastTs(ts);
    }
  } catch (e) {
    // Includes "slack MCP not connected" - log and try again next tick.
    log.warn(`[slackBridge] poll failed: ${(e as Error).message}`);
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
  '• `help`',
  '',
  '`<session>` can be a name (or part of one) or an id prefix.',
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
  const q = ref.trim().toLowerCase();
  if (!q) return { error: 'Which session? Give a name or id prefix.' };
  const byId = rows.filter((s) => s.id.toLowerCase().startsWith(q));
  const byName = rows.filter((s) => label(s).toLowerCase().includes(q));
  let cands = byId.length ? byId : byName;
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

export async function handleCommand(command: string): Promise<string> {
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

  // ---- new session <name> ----
  let m = cmd.match(/^new\s+session\s+(.+)$/i) || cmd.match(/^new\s+(.+)$/i);
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
  m = cmd.match(/^(?:send|tell|reply)\s+(\S+)\s+([\s\S]+)$/i);
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

  return `Didn't understand "${cmd}".\n\n${HELP}`;
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
