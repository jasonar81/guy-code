// Memory relevance retrieval (v2).
//
// v1 gated EVERYTHING non-pinned through a per-message relevance check, which
// made the agent forgetful: your live task-state notes ("what I've done / what
// I'm doing", which are `normal` tier, not pinned) got dropped whenever the
// current message didn't happen to mention them - and a terse message like
// "continue" matched nothing. The gate also re-ran every turn nondeterministi-
// cally, so notes flickered in and out.
//
// v2 fixes that with four changes:
//   1. ALWAYS-LOAD recent/active state. The N most-recently-modified `normal`
//      leaves (your live task state) load every turn regardless of the gate.
//   2. GATE ONLY THE TAIL. Older `normal` leaves + `archived` leaves are the
//      only gate candidates, so trimming the bloat never costs you recent work.
//   3. GATE ON CONTEXT. The gate sees recent conversation + the active plan,
//      not just the new message, so terse follow-ups still retrieve the right
//      notes.
//   4. STICKY SELECTION. Once a tail leaf is selected in a session it stays
//      selected for the rest of the session (persisted per session), so notes
//      don't flicker in and out turn to turn.
//
// The pinned core always loads (unchanged). Graceful degradation: any gate
// failure just means the tail isn't added that turn; recent/active state is
// always present, so a failure can never make the agent forgetful.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import log from 'electron-log';
import {
  listGuyMemory,
  listClaudeMemory,
  readExplicitTier,
  parseMdFrontmatter,
} from './memory';
import { getClient } from './anthropic';
import { getSetting, setSetting } from './db';

/** Cheap model used for the relevance gate. */
const GATE_MODEL = 'claude-haiku-4-5';

/** Always load this many most-recently-modified normal leaves (task state). */
const ALWAYS_RECENT_NORMAL = 12;
/** Total byte budget for the always-loaded recent normal leaves. */
const RECENT_TOTAL_CAP = 96 * 1024;
/** Total byte budget for the gate-selected tail block. */
const TAIL_TOTAL_CAP = 48 * 1024;
const PER_LEAF_CAP = 24 * 1024;
/** If the tail is this small, skip the gate and just include it all. */
const GATE_MIN_CANDIDATES = 6;
/**
 * Cap on the memory-relevance call. It runs before EVERY turn and blocks it,
 * so an unbounded request means an unbounded freeze - measured at 15s and 34s
 * on a real machine. Past this we skip the optional tail notes for the turn.
 */
const GATE_TIMEOUT_MS = 4_000;
/** How long a gate answer stays good for. */
const GATE_CACHE_MS = 90_000;
/** contextKey -> the names the gate last chose. Bounded to ~32 entries. */
const _gateCache = new Map<string, { at: number; names: string[] }>();

export interface LeafMeta {
  path: string;
  name: string;
  description: string;
  pinned: boolean;
  tier: 'pinned' | 'normal' | 'archived';
  bytes: number;
  mtime: number;
}

/**
 * Enumerate every memory leaf with its name/description/tier/mtime. Pinned
 * leaves are flagged (always loaded). Claude root CLAUDE.md is treated as
 * pinned (small + universal); other Claude imports are `normal`.
 */
export function gatherLeafMeta(args: { cwd: string; projectId?: string }): LeafMeta[] {
  const { cwd } = args;
  const projectId = args.projectId ?? '';
  const out: LeafMeta[] = [];

  for (const row of listGuyMemory({ scope: 'all', projectId })) {
    const fm = parseMdFrontmatter(row.path);
    const explicit = readExplicitTier(row.path);
    const tier: LeafMeta['tier'] =
      explicit === 'pinned' ? 'pinned' : explicit === 'archived' ? 'archived' : 'normal';
    out.push({
      path: row.path,
      name: fm.name || basename(row.path).replace(/\.md$/i, ''),
      description: fm.description || firstLine(row.path),
      pinned: tier === 'pinned',
      tier,
      bytes: row.bytes,
      mtime: row.mtime,
    });
  }

  for (const c of listClaudeMemory({ cwd, projectId })) {
    const isRootClaudeMd = /(^|[\\/])CLAUDE\.md$/i.test(c.path);
    out.push({
      path: c.path,
      name: c.name || basename(c.path).replace(/\.md$/i, ''),
      description: c.description || firstLine(c.path),
      pinned: isRootClaudeMd,
      tier: isRootClaudeMd ? 'pinned' : 'normal',
      bytes: c.bytes,
      mtime: c.mtime,
    });
  }

  const seen = new Set<string>();
  return out.filter((m) => (seen.has(m.path) ? false : (seen.add(m.path), true)));
}

function firstLine(path: string): string {
  try {
    const t = readFileSync(path, 'utf8').replace(/^---[\s\S]*?\n---\n/, '');
    const line = t.split('\n').find((l) => l.trim() && !l.startsWith('#'));
    return (line || '').trim().slice(0, 140);
  } catch {
    return '';
  }
}

/** Extract the first JSON array of strings from model text. */
function parseNameArray(text: string): string[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string');
    return null;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Ask the cheap model which TAIL leaves are relevant, given the recent
 * conversation context (not just the latest message). Returns the matched
 * leaf names. Never throws.
 */
export async function gateTail(
  contextText: string,
  tail: LeafMeta[],
  apiKeyId?: string | null
): Promise<string[]> {
  if (tail.length === 0) return [];
  if (tail.length <= GATE_MIN_CANDIDATES) return tail.map((t) => t.name);

  // Serve a recent answer rather than calling the model again. This runs
  // BEFORE EVERY TURN, and the call is a network round trip: measured stalls
  // of 15s and 34s on a real machine, where the only thing between
  // "appended placeholder user message" and "loaded memory" was this request.
  // The set of relevant notes barely moves within a single piece of work, so a
  // short-lived cache removes almost all of those calls.
  const cacheKey = `${tail.length}:${truncate(contextText, 400)}`;
  const cached = _gateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GATE_CACHE_MS) {
    return cached.names;
  }

  try {
    const list = tail.map((c) => `- ${c.name}: ${truncate(c.description, 200)}`).join('\n');
    const client = getClient(apiKeyId);
    // HARD TIMEOUT. Without one this call is unbounded, and a slow response
    // holds up the whole turn - which is exactly what the 34s freeze was. If
    // it doesn't answer quickly we simply skip the optional tail notes; the
    // pinned/recent memory is loaded regardless, so nothing important is lost.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GATE_TIMEOUT_MS);
    let resp;
    try {
      resp = await client.messages.create(
        {
          model: GATE_MODEL,
          max_tokens: 1024,
      system:
        'You select which of the user\'s older saved notes are relevant to what they are CURRENTLY working on. ' +
        'You are given recent conversation context (and possibly an active plan) plus a list of note names+descriptions. ' +
        'Return ONLY a JSON array of the exact `name` values worth loading. Prefer to INCLUDE a note if there is any reasonable chance it applies to the current work (recall matters more than precision here); always include relevant safety, workflow, and convention rules. ' +
        'Return [] if none apply. Output nothing but the JSON array.',
          messages: [
            {
              role: 'user',
              content: `Older saved notes (name: description):\n${list}\n\nWhat I'm currently working on:\n${truncate(
                contextText,
                8000
              )}`,
            },
          ],
        },
        { signal: ctrl.signal }
      );
    } finally {
      clearTimeout(timer);
    }
    const text = (resp.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    const names = parseNameArray(text);
    if (names === null) throw new Error('gate returned no parseable JSON array');
    _gateCache.set(cacheKey, { at: Date.now(), names });
    if (_gateCache.size > 32) {
      // Cheap bound: drop the oldest entry.
      const oldest = [..._gateCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) _gateCache.delete(oldest[0]);
    }
    return names;
  } catch (e) {
    log.warn(`[memoryRetrieval] tail gate failed (${(e as Error).message}); tail not added this turn`);
    return [];
  }
}

/** Concatenate leaf bodies under a total + per-leaf cap. */
function concatBodies(metas: LeafMeta[], totalCap: number): string {
  const parts: string[] = [];
  let total = 0;
  for (const m of metas) {
    if (total >= totalCap) break;
    try {
      let body = readFileSync(m.path, 'utf8');
      if (body.length > PER_LEAF_CAP) body = body.slice(0, PER_LEAF_CAP);
      const remaining = totalCap - total;
      if (body.length > remaining) body = body.slice(0, remaining);
      parts.push(`<<< ${m.path} >>>\n${body}`);
      total += body.length;
    } catch {
      /* skip unreadable */
    }
  }
  return parts.join('\n\n');
}

function concatBodiesUncapped(metas: LeafMeta[]): string {
  const parts: string[] = [];
  for (const m of metas) {
    try {
      parts.push(`<<< ${m.path} >>>\n${readFileSync(m.path, 'utf8')}`);
    } catch {
      /* skip */
    }
  }
  return parts.join('\n\n');
}

// ---- Sticky per-session selection (persisted in settings) -----------------
function stickyKey(sessionId: string): string {
  return `mem_retrieval_sticky_${sessionId}`;
}
function loadSticky(sessionId: string): Set<string> {
  try {
    const raw = getSetting(stickyKey(sessionId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}
function saveSticky(sessionId: string, names: Set<string>): void {
  try {
    setSetting(stickyKey(sessionId), JSON.stringify([...names]));
  } catch {
    /* best-effort */
  }
}

export interface RelevantMemory {
  /** Always-on pinned core (goes in the cached system prefix). */
  pinnedText: string;
  /**
   * Recent/active task state (most-recent normal leaves) + gate-selected tail.
   * Goes in a per-turn block after the pinned core.
   */
  retrievedText: string;
  /** Names of every non-pinned leaf included this turn (recent + tail). */
  selectedNames: string[];
  via: 'recent+gate' | 'recent-only';
}

/**
 * Build the per-turn memory: pinned core (always) + the N most-recent normal
 * leaves (always, = task state) + a sticky, context-gated tail of older/archived
 * leaves.
 */
export async function loadRelevantMemory(args: {
  cwd: string;
  projectId?: string;
  /** Recent conversation context + active plan (what the gate matches on). */
  contextText: string;
  sessionId?: string;
  apiKeyId?: string | null;
}): Promise<RelevantMemory> {
  const metas = gatherLeafMeta({ cwd: args.cwd, projectId: args.projectId });
  const pinned = metas.filter((m) => m.pinned);
  const nonPinned = metas.filter((m) => !m.pinned);

  // Split non-pinned into "recent normal" (always loaded = task state) and the
  // "tail" (older normal + archived = gate candidates), newest-first.
  const normal = nonPinned.filter((m) => m.tier === 'normal').sort((a, b) => b.mtime - a.mtime);
  const archived = nonPinned.filter((m) => m.tier === 'archived').sort((a, b) => b.mtime - a.mtime);
  const recent = normal.slice(0, ALWAYS_RECENT_NORMAL);
  const tail = [...normal.slice(ALWAYS_RECENT_NORMAL), ...archived];

  // Gate the tail on conversation context, with sticky accumulation per session.
  const sticky = args.sessionId ? loadSticky(args.sessionId) : new Set<string>();
  const matched = await gateTail(args.contextText, tail, args.apiKeyId);
  for (const n of matched) sticky.add(n.toLowerCase().trim());
  if (args.sessionId) saveSticky(args.sessionId, sticky);
  const tailSelected = tail.filter((t) => sticky.has(t.name.toLowerCase().trim()));

  // Order: recent task state first (most important), then selected tail.
  const recentText = concatBodies(recent, RECENT_TOTAL_CAP);
  const tailText = concatBodies(tailSelected, TAIL_TOTAL_CAP);
  const retrievedText = [recentText, tailText].filter(Boolean).join('\n\n');

  return {
    pinnedText: concatBodiesUncapped(pinned),
    retrievedText,
    selectedNames: [...recent.map((r) => r.name), ...tailSelected.map((t) => t.name)],
    via: tailSelected.length > 0 || tail.length > 0 ? 'recent+gate' : 'recent-only',
  };
}
