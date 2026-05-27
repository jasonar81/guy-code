/**
 * Internal-state narration filter.
 *
 * The model is instructed in the system prompt (see `electron/anthropic.ts`
 * "what NOT to narrate (internal-state spam)") not to write running text
 * about its own memory operations, context compaction, save_memory tool
 * calls, "state is preserved" reassurances, etc. — but it leaks anyway,
 * especially after a forced wakeup or just before a tool call where the
 * model wants to "confirm" its bookkeeping before proceeding.
 *
 * This module is a render-time backstop: each paragraph of assistant text
 * is classified, and paragraphs that match the narration patterns get
 * rendered in a smaller, dimmer font. We pick "mute" over "hide" so a
 * false positive is recoverable (the user can still read the text); the
 * cost of an aggressive pattern set is just visual, not informational.
 *
 * Architecture decisions:
 *   • Render-time, not write-time. JSONL is the source of truth; we don't
 *     mutate what the model emitted, just how we present it. If the user
 *     ever exports / inspects the transcript the original text is intact.
 *   • Paragraph-granular, not sentence-granular. The typical leak is a
 *     whole preamble paragraph ("Memory is comprehensively saved. Let me
 *     continue."). Sentence splitting introduces false positives in
 *     normal prose and the win isn't worth it.
 *   • Fenced code blocks are atomic. We never want a `` ``` `` line
 *     inside a code block to look like a paragraph boundary, and we
 *     never want code mistakenly muted.
 *   • Pure, no DOM. Tested directly with Vitest.
 */

/**
 * Split an assistant text block into paragraphs (separated by one or
 * more blank lines), preserving fenced code blocks as single chunks.
 *
 * Behavior:
 *   • Lines starting with ``` toggle fenced-code mode. Blank lines
 *     inside a fence do NOT split.
 *   • Multiple consecutive blank lines act as a single separator.
 *   • Leading / trailing blank lines around the input are trimmed.
 *   • An empty / whitespace-only input returns an empty array.
 */
export function splitIntoChunks(text: string): string[] {
  if (!text || !text.trim()) return [];
  const lines = text.split('\n');
  const chunks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (buf.length === 0) return;
    // Trim trailing blank lines that crept into the buffer.
    while (buf.length > 0 && buf[buf.length - 1].trim() === '') buf.pop();
    if (buf.length > 0) chunks.push(buf.join('\n'));
    buf = [];
  };
  for (const line of lines) {
    // A fence delimiter (```) toggles atomic mode. Defensive: a line
    // like "```typescript" still opens a fence, and a closing "```"
    // closes it. We treat the fence tokens as part of the chunk.
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return chunks;
}

/**
 * Phrases that, anywhere in a paragraph, mark it as internal narration.
 *
 * The list is intentionally exhaustive against the user-supplied
 * exemplars (and the system prompt's own forbidden-phrases list). It
 * prefers false positives (text gets muted but is still readable) over
 * false negatives (noise pollutes the transcript).
 *
 * To tighten / loosen the filter, edit this list. Each pattern is
 * commented with the example it was added to catch.
 */
const NARRATION_PATTERNS: ReadonlyArray<RegExp> = [
  // -- Memory as topic --
  // "Memory is comprehensive in memory" / "Memory is comprehensively saved"
  /\bmemor(y|ies)\s+(is|are)\s+(now\s+|already\s+|fully\s+|comprehensiv\w+)?\s*(comprehensive|saved|captured|preserved|up\s+to\s+date|complete|ready)\b/i,
  // "State is fully captured in memory at demo_fleet_state (12.7KB)"
  /\bstate\s+(is|are)\s+(comprehensive|fully|already|now|completely)\s+(saved|captured|preserved|complete|in memory)\b/i,
  // "State fully saved." / "State preserved"
  /\bstate\s+(fully|already|comprehensive\w*)\s+(saved|captured|preserved|persisted)\b/i,
  // "saved to memory" / "captured in memory"
  /\b(saved?|stored?|wrote|captured?|persisted?|appended?|committed?)\s+(it\s+|them\s+|everything\s+|all\s+)?(to|in|into)\s+memor(y|ies)\b/i,
  // "memory leaf" / "memory leaves" / "memory tree"
  /\bmemor(y|ies)\s+(leaf|leaves|tree|entry|entries|node|nodes|append|appended)\b/i,
  // "save_memory" mentioned in text (vs. as a tool call card)
  /\bsave_memory\b/i,
  // "all critical info/state captured" / "everything I need saved"
  /\b(all\s+)?(critical|important|relevant|necessary)\s+(state|info|information|context|details?)\s+(is|are|now|fully|already)?\s*(captured|saved|preserved|in memory)\b/i,
  // "checkpoint saved"
  /\bcheckpoint\s+(saved|committed|persisted|written)\b/i,
  // "auto-load(s) next session" / "next session can pick up" / "next session resumes"
  /\b(auto-?loads?\s+next\s+session|next\s+session\s+(can\s+(pick\s+up|resume)|will\s+(have|load|see)|auto-?loads))\b/i,
  // "to resume from any point" / "pick up where we left off"
  /\b(to\s+resume\s+from\s+(any\s+point|here)|pick\s+up\s+where\s+(we|I)\s+left\s+off)\b/i,
  // "let me save before X" / "save before context"
  /\b(let\s+me\s+)?save\s+(it\s+|this\s+|everything\s+|state\s+|progress\s+)?(before|to)\s+(context|compaction|the\s+(prune|wipe|clear|context|compaction))\b/i,
  // "memory now contains everything"
  /\bmemory\s+now\s+contains\b/i,
  // "context fully captured/saved" / "saving the implementation plan to memory"
  /\bsav(e|ing)\s+(the\s+)?(implementation|progress|state|context|plan|remaining|action)\s+(plan\s+)?to\s+memor(y|ies)?\b/i,

  // -- Compaction / context-window concerns --
  // "Context is getting tight" / "context is wiped" / "context is approaching the limit".
  // Allow up to two words between `context` and the warning verb so
  // "context is getting tight" and "context is about to wipe" both match.
  /\bcontext\s+(?:\w+\s+){0,2}(tight|full|low|near|approaching|wipe[d]?|cleared?|reset|limit\w*)\b/i,
  // "running out of context" / "burning through context"
  /\b(running\s+out\s+of|burning\s+through)\s+context\b/i,
  /\bcontext[- ]?management\s+(beta|kicks|fires|triggered)\b/i,
  /\bmicro-?compaction\b/i,
  // "before context is wiped" / "before the next compaction" / "before the prune"
  // Permit `next` / `coming` / `imminent` etc. between "before [the]" and
  // the compaction noun so "before the next compaction" matches.
  /\bbefore\s+(?:the\s+)?(?:\w+\s+){0,2}(compaction|prune|wipe|clear|reset)\b/i,
  // "I should save before I lose this"
  /\bI\s+should\s+save\s+(it\s+|this\s+|now\s+|first\s+|before\b)/i,
  // "saving now before X" — pairs with compaction language often.
  /\bsaving\s+(now\s+|first\s+)?before\b/i,

  // -- Self-reassurance / status pings without content --
  // "I just verified by re-reading" / "I just checked"
  /\bI\s+(just\s+|already\s+)?(verified|checked|re-?read|re-?confirmed)\b/i,
  // "Continuing with the implementation" without new info (full-line check)
  /^\s*continuing\s+(with\s+)?(the\s+)?(implementation|work|plan|execution|task)\s*[.,;:]?\s*$/i,
  // "Memory is comprehensive — let me confirm and continue"
  /\blet\s+me\s+(confirm\s+and\s+)?continue\b/i,
  // "Now let me actually do X" (model second-guessing itself)
  /\bnow\s+let\s+me\s+actually\s+/i,

  // -- Byte/size mentions almost always paired with memory ops --
  // "(12.7KB)" / "(43989b)" — flag if appears alongside any memory/state word in the chunk
  // Implemented separately below as a contextual rule, not a standalone match.
];

/**
 * Contextual rule helpers — phrases that ALONE aren't enough to flag a
 * paragraph but that elevate confidence when combined with other signals.
 * Implemented in `isInternalNarration` rather than as standalone regexes
 * so we don't accidentally hide normal prose mentioning "X KB" file
 * sizes in unrelated contexts.
 */
const SIZE_PATTERN = /\(\s*\d+(\.\d+)?\s*(KB|MB|kb|mb|b|bytes?)\s*\)/;
const MEMORY_HINT_PATTERN = /\b(memor(y|ies)|state|context|leaf|leaves|checkpoint|save_memory|saved|captured|preserved|comprehensive|persisted)\b/i;

/**
 * Classify a single paragraph (already stripped of leading/trailing
 * blank lines) as internal narration or substantive content.
 *
 * Algorithm:
 *   1. Code-fenced paragraphs (lines starting with `` ``` ``) are
 *      ALWAYS substantive. Code is never narration.
 *   2. If any of the strong patterns above hits, → narration.
 *   3. Contextual: a paragraph mentioning a size in parens (e.g.
 *      "(12.7KB)") AND a memory/state hint word → narration.
 *   4. Otherwise → substantive.
 */
export function isInternalNarration(chunk: string): boolean {
  const trimmed = chunk.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('```')) return false;
  for (const re of NARRATION_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  if (SIZE_PATTERN.test(trimmed) && MEMORY_HINT_PATTERN.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Top-level helper: take an assistant text block and return the
 * paragraphs paired with a `muted` flag for the renderer to apply
 * styling. The original ordering and whitespace between chunks is
 * preserved by the caller (paragraphs are simply rejoined with `\n\n`
 * if needed; in practice the renderer emits each chunk in its own
 * wrapper element so explicit re-joining isn't required).
 */
export interface ClassifiedChunk {
  /** Raw text of the paragraph (no leading/trailing blank lines). */
  text: string;
  /** True when the paragraph matches a narration pattern. */
  muted: boolean;
}

export function classifyAssistantText(text: string): ClassifiedChunk[] {
  return splitIntoChunks(text).map((chunk) => ({
    text: chunk,
    muted: isInternalNarration(chunk),
  }));
}

/**
 * A run of consecutive chunks of a single kind. Returned by
 * `groupChunks` so the renderer can collapse muted runs behind a
 * single twisty (one disclosure per run of muted paragraphs, not
 * one per paragraph) while leaving substantive content rendered
 * inline as before.
 *
 * `firstIndex` / `lastIndex` are the original chunk positions in the
 * pre-grouping array. The renderer uses them to figure out whether
 * the streaming-cursor's "last chunk of the last block" sits inside
 * a given group (which forces auto-expansion so the user sees text
 * arriving live instead of just "▶ 1 internal note").
 */
export interface ChunkGroup {
  kind: 'muted' | 'normal';
  chunks: ClassifiedChunk[];
  /** Position of the first chunk in the original `classifyAssistantText` array. */
  firstIndex: number;
  /** Position of the last chunk in the original array (inclusive). */
  lastIndex: number;
}

/**
 * Group an array of classified chunks into consecutive runs by
 * `muted` flag. Returns one ChunkGroup per maximal run.
 *
 * Examples:
 *   [muted, muted, normal, muted] →
 *     [{kind:'muted', 2 chunks}, {kind:'normal', 1 chunk}, {kind:'muted', 1 chunk}]
 *   [normal, normal] →
 *     [{kind:'normal', 2 chunks}]
 *   [] → []
 *
 * Order is preserved end-to-end — the original [muted, muted,
 * normal, muted] sequence maps to a 3-group output in the same
 * positions. Callers that render each group in order will produce
 * the same paragraph ordering as the model emitted.
 */
export function groupChunks(chunks: ClassifiedChunk[]): ChunkGroup[] {
  if (chunks.length === 0) return [];
  const out: ChunkGroup[] = [];
  let current: ChunkGroup = {
    kind: chunks[0].muted ? 'muted' : 'normal',
    chunks: [chunks[0]],
    firstIndex: 0,
    lastIndex: 0,
  };
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    const kind: 'muted' | 'normal' = c.muted ? 'muted' : 'normal';
    if (kind === current.kind) {
      current.chunks.push(c);
      current.lastIndex = i;
    } else {
      out.push(current);
      current = { kind, chunks: [c], firstIndex: i, lastIndex: i };
    }
  }
  out.push(current);
  return out;
}
