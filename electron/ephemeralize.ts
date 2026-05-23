// Tool output ephemeralization. Per design (DESIGN.md → "Tool output
// ephemeralization"):
//   Tier 1 (verbatim): most recent result per tool name
//   Tier 2 (synopsis): older results replaced by deterministic 1-liner
//                      `[Bash#N exit=… NB output, ref:tr_…]`
//   Tier 3 (dropped):  older or larger than threshold
//
// Synopses must be deterministic so they don't bust prompt cache.
//
// Note: `ref:tr_…` ids are stable hashes of the original content; in this
// minimal version we don't yet persist a blob lookup table. The ref is
// still useful for the model and for human eyeballing.

import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

const TIER1_KEEP_PER_TOOL = 1;
/** Anything older than this many *messages* gets synopsified. */
const TIER1_KEEP_LAST_TURNS = 6;
/** Bigger than this is always synopsified, even if recent. */
const VERBATIM_MAX_BYTES = 6 * 1024;
/** Bigger than this is dropped entirely (Tier 3). */
const DROP_OVER_BYTES = 32 * 1024;

interface ToolUseInfo {
  name: string;
  /** 1-based index per tool name across this session window. */
  index: number;
}

/**
 * Walk a messages list and:
 *  - keep the latest verbatim tool_result for each tool name
 *  - keep recent (last N turns) results verbatim
 *  - replace older results with a deterministic synopsis
 *  - drop oversize results entirely (replaced with placeholder)
 *
 * Mutates a copy; the input array is not modified.
 */
export function ephemeralizeMessages(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  // Build name index from prior tool_use blocks so the synopsis can name them.
  const toolUseById = new Map<string, ToolUseInfo>();
  const perToolCounter = new Map<string, number>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === 'tool_use') {
        const next = (perToolCounter.get(b.name) ?? 0) + 1;
        perToolCounter.set(b.name, next);
        toolUseById.set(b.id, { name: b.name, index: next });
      }
    }
  }

  // Find the index of the latest tool_result for each tool name (so we keep
  // it verbatim).
  const latestResultIdxByTool = new Map<string, number>();
  // Iterate from end to mark the most recent occurrence per tool name.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === 'tool_result') {
        const tu = toolUseById.get(b.tool_use_id);
        if (!tu) continue;
        if (!latestResultIdxByTool.has(tu.name)) {
          latestResultIdxByTool.set(tu.name, i);
        }
      }
    }
  }

  const cutoff = messages.length - TIER1_KEEP_LAST_TURNS;

  return messages.map((m, i) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return m;
    const newContent = (m.content as any[]).map((b) => {
      if (b?.type !== 'tool_result') return b;
      const tu = toolUseById.get(b.tool_use_id);
      if (!tu) return b;
      const isLatestForTool = latestResultIdxByTool.get(tu.name) === i;
      const isRecent = i >= cutoff;
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      const bytes = Buffer.byteLength(text, 'utf8');

      // Tier 3: too large, drop entirely.
      if (bytes > DROP_OVER_BYTES) {
        return {
          ...b,
          content: synopsis(tu, bytes, b.is_error, '[dropped: too large]'),
        };
      }
      // Tier 1: keep verbatim (latest of its kind, or recent, and not too big).
      if ((isLatestForTool || isRecent) && bytes <= VERBATIM_MAX_BYTES) {
        return b;
      }
      // Tier 2: synopsify.
      return {
        ...b,
        content: synopsis(tu, bytes, b.is_error, summary(text)),
      };
    });
    return { ...m, content: newContent } as Anthropic.MessageParam;
  });
}

function synopsis(
  tu: ToolUseInfo,
  bytes: number,
  isError: boolean | undefined,
  hint: string
): string {
  const ref = createHash('sha1').update(`${tu.name}:${tu.index}:${hint}`).digest('hex').slice(0, 8);
  const status = isError ? ' error' : '';
  const kb = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
  return `[${tu.name}#${tu.index}${status} ${kb} ref:tr_${ref}] ${hint}`.trim();
}

function summary(text: string): string {
  // First line that's neither blank nor a bracketed status header.
  const lines = text.split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('[') && t.endsWith(']')) continue;
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }
  return '(empty)';
}
