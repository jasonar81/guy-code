// Memory relevance retrieval.
//
// Instead of dumping the ENTIRE memory tree (~64K tokens) into every prompt's
// system block - which is costly, dilutes attention, and (with Claude Fable 5)
// triggers safety refusals when security/systems-code notes are present - we:
//   1. ALWAYS load the small pinned core (a handful of truly-universal rules).
//   2. For everything else, ask a CHEAP model (Haiku) which notes are relevant
//      to the current user message, and load ONLY those.
//
// This keeps the per-turn system prompt small + on-topic, cuts cost, and means
// e.g. security notes only load when the task is actually about security.
//
// Graceful degradation: any failure in the gate (parse error, timeout, no key)
// falls back to a recency-bounded subset, so retrieval never breaks a turn.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import log from 'electron-log';
import {
  listGuyMemory,
  listClaudeMemory,
  getEffectiveTier,
  readExplicitTier,
  parseMdFrontmatter,
} from './memory';
import { getClient } from './anthropic';

/** Cheap model used for the relevance gate. */
const GATE_MODEL = 'claude-haiku-4-5';

/** Caps for the retrieved (non-pinned) memory block. */
const RETRIEVED_TOTAL_CAP = 48 * 1024; // ~12K tokens of selected memory
const PER_LEAF_CAP = 16 * 1024;
/** Below this many candidates, skip the gate and just include them all. */
const GATE_MIN_CANDIDATES = 6;
/** Fallback: when the gate fails, include the N newest candidates under cap. */
const FALLBACK_NEWEST = 8;

export interface LeafMeta {
  path: string;
  name: string;
  description: string;
  pinned: boolean;
  bytes: number;
  mtime: number;
}

/**
 * Enumerate every memory leaf (Guy-owned + read-only Claude imports) with its
 * name/description/tier. Pinned leaves are flagged (they're always loaded, so
 * they're not candidates for the gate).
 */
export function gatherLeafMeta(args: { cwd: string; projectId?: string }): LeafMeta[] {
  const { cwd } = args;
  const projectId = args.projectId ?? '';
  const out: LeafMeta[] = [];

  // Guy-owned leaves (these carry an explicit tier).
  for (const row of listGuyMemory({ scope: 'all', projectId })) {
    const fm = parseMdFrontmatter(row.path);
    const pinned = readExplicitTier(row.path) === 'pinned';
    out.push({
      path: row.path,
      name: fm.name || basename(row.path).replace(/\.md$/i, ''),
      description: fm.description || firstLine(row.path),
      pinned,
      bytes: row.bytes,
      mtime: row.mtime,
    });
  }

  // Read-only Claude imports (can't be re-tiered by us; never pinned by us,
  // but the loader does always include CLAUDE.md-style ones - we treat them as
  // gate candidates so security content only loads when relevant). The session
  // CLAUDE.md (global) is small + universal; keep it always-on by flagging it
  // pinned here so it isn't gated out.
  for (const c of listClaudeMemory({ cwd, projectId })) {
    const isRootClaudeMd = /(^|[\\/])CLAUDE\.md$/i.test(c.path);
    out.push({
      path: c.path,
      name: c.name || basename(c.path).replace(/\.md$/i, ''),
      description: c.description || firstLine(c.path),
      pinned: isRootClaudeMd,
      bytes: c.bytes,
      mtime: c.mtime,
    });
  }

  // De-dup by path (a leaf could be discovered twice).
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

/**
 * Ask the cheap model which candidate leaves are relevant to the user message.
 * Returns the subset of candidates to load. Never throws - on any failure it
 * falls back to the newest candidates under a byte budget.
 */
export async function selectRelevant(
  userMessage: string,
  candidates: LeafMeta[],
  apiKeyId?: string | null
): Promise<{ selected: LeafMeta[]; via: 'gate' | 'all' | 'fallback' }> {
  if (candidates.length === 0) return { selected: [], via: 'all' };
  if (candidates.length <= GATE_MIN_CANDIDATES) {
    return { selected: candidates, via: 'all' };
  }
  try {
    const list = candidates
      .map((c) => `- ${c.name}: ${truncate(c.description, 200)}`)
      .join('\n');
    const client = getClient(apiKeyId);
    const resp = await client.messages.create({
      model: GATE_MODEL,
      max_tokens: 1024,
      system:
        'You select which of the user\'s saved notes are relevant to their current message. ' +
        'Return ONLY a JSON array of the exact `name` values of the relevant notes. ' +
        'Include a note if there is any reasonable chance it applies; always include safety, ' +
        'security, workflow, and style/convention rules when the work could touch them. ' +
        'Return [] if none are relevant. Output nothing but the JSON array.',
      messages: [
        {
          role: 'user',
          content: `Saved notes (name: description):\n${list}\n\nMy current message:\n${truncate(
            userMessage,
            4000
          )}`,
        },
      ],
    });
    const text = (resp.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    const names = parseNameArray(text);
    if (names === null) throw new Error('gate returned no parseable JSON array');
    const wanted = new Set(names.map((n) => n.toLowerCase().trim()));
    const selected = candidates.filter((c) => wanted.has(c.name.toLowerCase().trim()));
    return { selected, via: 'gate' };
  } catch (e) {
    log.warn(`[memoryRetrieval] relevance gate failed (${(e as Error).message}); using recency fallback`);
    const byNew = [...candidates].sort((a, b) => b.mtime - a.mtime);
    const out: LeafMeta[] = [];
    let total = 0;
    for (const c of byNew) {
      if (out.length >= FALLBACK_NEWEST || total + c.bytes > RETRIEVED_TOTAL_CAP) break;
      out.push(c);
      total += c.bytes;
    }
    return { selected: out, via: 'fallback' };
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

/** Concatenate selected leaf bodies under the caps. */
function concatBodies(metas: LeafMeta[]): string {
  const parts: string[] = [];
  let total = 0;
  for (const m of metas) {
    if (total >= RETRIEVED_TOTAL_CAP) break;
    try {
      let body = readFileSync(m.path, 'utf8');
      if (body.length > PER_LEAF_CAP) body = body.slice(0, PER_LEAF_CAP);
      const remaining = RETRIEVED_TOTAL_CAP - total;
      if (body.length > remaining) body = body.slice(0, remaining);
      parts.push(`<<< ${m.path} >>>\n${body}`);
      total += body.length;
    } catch {
      /* skip unreadable */
    }
  }
  return parts.join('\n\n');
}

/** Load the pinned-core leaf bodies (always included). */
function loadPinnedBodies(metas: LeafMeta[]): string {
  const pinned = metas.filter((m) => m.pinned);
  return concatBodiesUncapped(pinned);
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

export interface RelevantMemory {
  /** Always-on pinned core (goes in the cached system prefix). */
  pinnedText: string;
  /** Relevance-selected non-pinned memory (per-turn system block). */
  retrievedText: string;
  /** Names of the selected leaves, for logging/transparency. */
  selectedNames: string[];
  via: 'gate' | 'all' | 'fallback';
}

/**
 * The main entry point: returns the pinned core + the relevance-selected
 * memory for a given user message.
 */
export async function loadRelevantMemory(args: {
  cwd: string;
  projectId?: string;
  userMessage: string;
  apiKeyId?: string | null;
}): Promise<RelevantMemory> {
  const metas = gatherLeafMeta({ cwd: args.cwd, projectId: args.projectId });
  const candidates = metas.filter((m) => !m.pinned);
  const { selected, via } = await selectRelevant(args.userMessage, candidates, args.apiKeyId);
  return {
    pinnedText: loadPinnedBodies(metas),
    retrievedText: concatBodies(selected),
    selectedNames: selected.map((s) => s.name),
    via,
  };
}
