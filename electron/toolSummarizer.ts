/**
 * Tool result summarization with on-disk archive.
 *
 * When a tool produces a large output (a Bash run that prints 5K lines, a
 * Read on a giant file, a Grep with thousands of matches), we don't want
 * the full text to land in the model's context. It bloats every
 * subsequent turn, accelerates compaction, and pushes useful older
 * material out faster than necessary.
 *
 * Strategy:
 *   1. After the tool runs, measure its output size.
 *   2. If under a per-tool threshold, pass through unchanged.
 *   3. If over, write the FULL output to disk under
 *      `~/.guycode/tool-results/<session-id>/<call-id>.txt` (with a
 *      `.json` sidecar carrying tool name / args hash / timestamps), then
 *      replace the tool_result content with a tool-specific summary that
 *      tells the model the size, key excerpts, and the absolute archive
 *      path so it can use Read for any specific portion it needs.
 *
 * Errors are NEVER summarized (they're usually small anyway and the
 * model needs the exact stderr to react). Unknown tools fall back to a
 * generic head+tail summarizer.
 *
 * Cleanup happens at app start: anything older than `CLEANUP_AGE_DAYS`
 * is deleted in a single sweep. The setting is intentionally not
 * user-configurable yet — defaults are tuned for typical usage and we
 * can add a Settings knob if anyone hits a corner case.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import log from 'electron-log';

/**
 * Per-tool size thresholds (in characters). Anything at or above the
 * threshold for its tool gets summarized. ~4 chars per token is the
 * rule of thumb for English, so e.g. 12000 chars ≈ 3K tokens — about
 * the point where a single tool result starts noticeably eating into
 * an otherwise lean turn.
 *
 * These are deliberately generous: better to let a borderline result
 * through verbatim than to cut something the model needed. The bigger
 * win is on the long-tail (50K+ char dumps from `cat largefile`).
 */
const THRESHOLDS: Record<string, number> = {
  Bash: 12_000,
  PowerShell: 12_000,
  Read: 16_000, // Read is intentionally larger; users explicitly ask for big files.
  Grep: 6_000, // Grep should be concise; if it's huge, narrow the pattern.
  Glob: 6_000,
  WebFetch: 16_000,
  // WebSearch is smaller than WebFetch — title + URL + snippet for ~10
  // hits is normally 3-5K chars. The threshold catches `max_results=25`
  // searches and pathological snippet bloat without firing on normal use.
  WebSearch: 10_000,
};
const DEFAULT_THRESHOLD = 12_000;

/** Tools that should NEVER be summarized regardless of size. */
const NEVER_SUMMARIZE = new Set<string>([
  // The skill body IS the instruction set; cutting it would defeat the
  // entire mechanism.
  'skill',
  // Plan / TodoWrite outputs are tiny structured payloads we want
  // verbatim for the UI.
  'TodoWrite',
  'Plan',
  // Subagent results are already summarized by the subagent itself
  // before returning; double-summarizing throws away nuance.
  'Task',
  'Plan_Subagent',
  'Execute',
  'Review',
]);

/** Lifetime for archived tool results before background cleanup. */
const CLEANUP_AGE_DAYS = 30;

/**
 * Resolves to the archive root directory (`~/.guycode/tool-results/`).
 * Indirected through a module-level binding rather than calling
 * `homedir()` directly so tests can swap in a temp dir without having
 * to rely on `vi.mock('node:os')` (which is finicky around the
 * `node:` prefix in vitest 4 and ESM-vs-CJS resolution).
 */
let _archiveRootOverride: string | null = null;

/** Test-only: pin the archive root to a specific path. */
export function _setArchiveRootForTesting(path: string | null): void {
  _archiveRootOverride = path;
}

function archiveRoot(): string {
  if (_archiveRootOverride) return _archiveRootOverride;
  return join(homedir(), '.guycode', 'tool-results');
}

function archiveDir(sessionId: string): string {
  return join(archiveRoot(), sessionId);
}

/**
 * Result returned to the caller. `content` is what should be sent to
 * the model AND broadcast to the UI. `archivePath`, when set, points
 * to the on-disk full output for follow-up Read calls. The content
 * already references this path inline so callers don't need to do
 * anything extra.
 */
export interface SummarizedToolResult {
  content: string;
  isError: boolean;
  /** Set when the result was large enough to summarize and archive. */
  archivePath: string | null;
  /** Original size in characters before summarization (0 if pass-through). */
  originalChars: number;
}

interface MaybeSummarizeArgs {
  toolName: string;
  toolInput: unknown;
  sessionId: string;
  toolUseId: string;
  rawContent: string;
  isError: boolean;
}

/**
 * Main entry point. Decides whether to summarize, archives if so, and
 * returns the post-processed result. Pure function modulo filesystem
 * writes; callers can replace it with a no-op for tests if needed.
 */
export function maybeSummarize(args: MaybeSummarizeArgs): SummarizedToolResult {
  const { toolName, toolInput, sessionId, toolUseId, rawContent, isError } = args;

  // Errors are passed through verbatim. They're usually small (stderr
  // snippet) and any model recovery hinges on the exact wording.
  if (isError) {
    return { content: rawContent, isError, archivePath: null, originalChars: 0 };
  }

  if (NEVER_SUMMARIZE.has(toolName)) {
    return { content: rawContent, isError, archivePath: null, originalChars: 0 };
  }

  const threshold = THRESHOLDS[toolName] ?? DEFAULT_THRESHOLD;
  if (rawContent.length < threshold) {
    return { content: rawContent, isError, archivePath: null, originalChars: 0 };
  }

  // Archive the full output before any in-memory mutation. If the
  // archive write fails, we DON'T fail the tool — we just pass the
  // raw content through. The model losing access to the archive path
  // is annoying but not catastrophic; failing a tool over a disk
  // write would be much worse.
  let archivePath: string | null = null;
  try {
    archivePath = writeArchive({ sessionId, toolUseId, toolName, toolInput, rawContent });
  } catch (e) {
    log.warn('[toolSummarizer] archive write failed', e);
    return { content: rawContent, isError, archivePath: null, originalChars: rawContent.length };
  }

  const summary = buildSummary(toolName, rawContent, archivePath);
  return {
    content: summary,
    isError,
    archivePath,
    originalChars: rawContent.length,
  };
}

function writeArchive(opts: {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  toolInput: unknown;
  rawContent: string;
}): string {
  const dir = archiveDir(opts.sessionId);
  mkdirSync(dir, { recursive: true });
  const txtPath = join(dir, `${opts.toolUseId}.txt`);
  const jsonPath = join(dir, `${opts.toolUseId}.json`);
  writeFileSync(txtPath, opts.rawContent, 'utf8');
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        toolName: opts.toolName,
        toolUseId: opts.toolUseId,
        sessionId: opts.sessionId,
        bytes: Buffer.byteLength(opts.rawContent, 'utf8'),
        chars: opts.rawContent.length,
        archivedAt: Date.now(),
        // Truncate input snapshot so a giant Edit input doesn't blow
        // up the sidecar. Just enough to identify what the call was.
        inputPreview: previewInput(opts.toolInput),
      },
      null,
      2
    ),
    'utf8'
  );
  return txtPath;
}

function previewInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v.length > 200 ? v.slice(0, 200) + '…' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Per-tool summarizers
// ---------------------------------------------------------------------

function buildSummary(toolName: string, rawContent: string, archivePath: string): string {
  const summarizer = SUMMARIZERS[toolName] ?? genericSummary;
  const body = summarizer(rawContent);
  return [
    `[Output was large: ${rawContent.length.toLocaleString()} chars / ~${Math.ceil(rawContent.length / 4).toLocaleString()} tokens. Auto-summarized below.]`,
    '',
    body,
    '',
    `Full output saved to: ${archivePath}`,
    `(Use Read with that absolute path, plus offset/limit, to view specific portions verbatim.)`,
  ].join('\n');
}

type Summarizer = (raw: string) => string;

const SUMMARIZERS: Record<string, Summarizer> = {
  Bash: bashSummary,
  PowerShell: bashSummary, // same shape — text output with possible exit code marker
  Read: readSummary,
  Grep: grepSummary,
  Glob: globSummary,
  WebFetch: webFetchSummary,
  WebSearch: webSearchSummary,
};

function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/);
}

function bashSummary(raw: string): string {
  const lines = splitLines(raw);
  const head = lines.slice(0, 50);
  const tail = lines.slice(-30);
  const skipped = Math.max(0, lines.length - head.length - tail.length);
  const errCount = lines.filter((l) => /\b(error|fatal|panic)\b/i.test(l)).length;
  const warnCount = lines.filter((l) => /\bwarning\b/i.test(l)).length;
  const failCount = lines.filter((l) => /\b(failed|failure)\b/i.test(l)).length;
  const parts: string[] = [];
  parts.push(`[First ${head.length} lines]`);
  parts.push(head.join('\n'));
  if (skipped > 0) {
    parts.push('');
    parts.push(`[... skipped ${skipped.toLocaleString()} middle lines ...]`);
    parts.push('');
    parts.push(`[Last ${tail.length} lines]`);
    parts.push(tail.join('\n'));
  }
  if (errCount > 0 || warnCount > 0 || failCount > 0) {
    parts.push('');
    parts.push(
      `[Markers in full output: ${errCount} error/fatal/panic, ${warnCount} warning, ${failCount} fail/failure lines]`
    );
  }
  return parts.join('\n');
}

function readSummary(raw: string): string {
  const lines = splitLines(raw);
  const head = lines.slice(0, 60);
  const tail = lines.slice(-30);
  const skipped = Math.max(0, lines.length - head.length - tail.length);
  const parts: string[] = [];
  parts.push(`[Total: ${lines.length.toLocaleString()} lines]`);
  parts.push('');
  parts.push(`[First ${head.length} lines]`);
  parts.push(head.join('\n'));
  if (skipped > 0) {
    parts.push('');
    parts.push(`[... skipped ${skipped.toLocaleString()} middle lines ...]`);
    parts.push('');
    parts.push(`[Last ${tail.length} lines]`);
    parts.push(tail.join('\n'));
  }
  return parts.join('\n');
}

function grepSummary(raw: string): string {
  const lines = splitLines(raw).filter((l) => l.length > 0);
  const head = lines.slice(0, 30);
  const remaining = Math.max(0, lines.length - head.length);
  // Try to count matches per file (ripgrep format: `path:line:col:text`).
  const fileCounts = new Map<string, number>();
  for (const l of lines) {
    const m = l.match(/^([^:\n]+):/);
    if (m) {
      fileCounts.set(m[1], (fileCounts.get(m[1]) ?? 0) + 1);
    }
  }
  const topFiles = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const parts: string[] = [];
  parts.push(`[Total: ${lines.length.toLocaleString()} matches across ${fileCounts.size} files]`);
  parts.push('');
  parts.push(`[First ${head.length} matches]`);
  parts.push(head.join('\n'));
  if (remaining > 0) {
    parts.push('');
    parts.push(`[... ${remaining.toLocaleString()} more matches ...]`);
  }
  if (topFiles.length > 0) {
    parts.push('');
    parts.push('[Top files by match count]');
    for (const [f, c] of topFiles) {
      parts.push(`  ${c.toString().padStart(6)} ${f}`);
    }
  }
  return parts.join('\n');
}

function globSummary(raw: string): string {
  const lines = splitLines(raw).filter((l) => l.length > 0);
  const head = lines.slice(0, 50);
  const remaining = Math.max(0, lines.length - head.length);
  // Bucket paths by their first path segment for a "where is the
  // bulk?" view.
  const bucketCounts = new Map<string, number>();
  for (const l of lines) {
    const seg = l.split(/[\\/]/, 1)[0] || '<root>';
    bucketCounts.set(seg, (bucketCounts.get(seg) ?? 0) + 1);
  }
  const topBuckets = [...bucketCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const parts: string[] = [];
  parts.push(`[Total: ${lines.length.toLocaleString()} paths]`);
  parts.push('');
  parts.push(`[First ${head.length} paths]`);
  parts.push(head.join('\n'));
  if (remaining > 0) {
    parts.push('');
    parts.push(`[... ${remaining.toLocaleString()} more paths ...]`);
  }
  if (topBuckets.length > 1) {
    parts.push('');
    parts.push('[Top top-level segments]');
    for (const [b, c] of topBuckets) {
      parts.push(`  ${c.toString().padStart(6)} ${b}`);
    }
  }
  return parts.join('\n');
}

function webFetchSummary(raw: string): string {
  // WebFetch returns "Title: ...\nURL: ...\n\n<body>" by convention
  // (see webFetch.ts). Show the title + first 1500 body chars.
  const lines = splitLines(raw);
  const meta: string[] = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length && i < 10; i++) {
    if (lines[i].trim() === '') {
      bodyStart = i + 1;
      break;
    }
    meta.push(lines[i]);
  }
  const body = lines.slice(bodyStart).join('\n');
  const headBody = body.length > 1500 ? body.slice(0, 1500) + '…' : body;
  const parts: string[] = [];
  if (meta.length > 0) {
    parts.push(meta.join('\n'));
    parts.push('');
  }
  parts.push(`[Body length: ${body.length.toLocaleString()} chars]`);
  parts.push('');
  parts.push(headBody);
  return parts.join('\n');
}

function webSearchSummary(raw: string): string {
  // WebSearch returns "Search results for: <query>\nFound N results.\n\n
  // 1. <title>\n   <url>\n   <snippet>\n\n2. ...". To summarize, we keep
  // the header lines and trim each result's snippet to one line. The
  // structure is preserved so the model can still pick a result and
  // call WebFetch on the URL — losing snippets is far cheaper than
  // dropping the URLs entirely.
  const lines = splitLines(raw);
  const out: string[] = [];
  // Pull the header lines (up to and including the first blank line).
  let i = 0;
  for (; i < lines.length && i < 4; i++) {
    out.push(lines[i]);
    if (lines[i].trim() === '' && i > 0) {
      i++;
      break;
    }
  }
  // Walk the result blocks. A block looks like:
  //   N. title
  //      url
  //      snippet (possibly multi-line)
  //   <blank>
  // We keep title + URL verbatim and truncate the snippet at 200 chars.
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\d+\.\s+/.test(line)) {
      out.push(line); // numbered title
      // URL on next line
      if (i + 1 < lines.length) {
        out.push(lines[i + 1]);
      }
      // Snippet — collect until blank line or next numbered entry.
      const snippetParts: string[] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const s = lines[j];
        if (s.trim() === '' || /^\s*\d+\.\s+/.test(s)) break;
        snippetParts.push(s.trim());
      }
      const snippet = snippetParts.join(' ').replace(/\s+/g, ' ').trim();
      if (snippet) {
        out.push(`   ${snippet.length > 200 ? snippet.slice(0, 200) + '…' : snippet}`);
      }
      out.push('');
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('\n').trimEnd();
}

function genericSummary(raw: string): string {
  const lines = splitLines(raw);
  const head = lines.slice(0, 60);
  const tail = lines.slice(-30);
  const skipped = Math.max(0, lines.length - head.length - tail.length);
  const parts: string[] = [];
  parts.push(`[First ${head.length} lines]`);
  parts.push(head.join('\n'));
  if (skipped > 0) {
    parts.push('');
    parts.push(`[... skipped ${skipped.toLocaleString()} middle lines ...]`);
    parts.push('');
    parts.push(`[Last ${tail.length} lines]`);
    parts.push(tail.join('\n'));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------
// Cleanup sweep — called once at app start.
// ---------------------------------------------------------------------

/**
 * Walk `~/.guycode/tool-results/` and delete any file whose mtime is
 * older than `CLEANUP_AGE_DAYS`. Safe to call repeatedly; logs a
 * single summary line. Failures are swallowed (best-effort) since
 * cleanup is purely housekeeping.
 */
export function cleanupArchives(): void {
  const root = archiveRoot();
  if (!existsSync(root)) return;
  const cutoff = Date.now() - CLEANUP_AGE_DAYS * 24 * 60 * 60 * 1000;
  let deletedFiles = 0;
  let deletedBytes = 0;
  try {
    for (const sessionDir of readdirSync(root)) {
      const dir = join(root, sessionDir);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(dir);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      let remaining = 0;
      for (const f of readdirSync(dir)) {
        const full = join(dir, f);
        try {
          const fst = statSync(full);
          if (fst.mtimeMs < cutoff) {
            unlinkSync(full);
            deletedFiles++;
            deletedBytes += fst.size;
          } else {
            remaining++;
          }
        } catch {
          /* ignore */
        }
      }
      // If the session directory ended up empty, remove it too so the
      // archive root doesn't accumulate stale empty dirs.
      if (remaining === 0) {
        try {
          rmdirSync(dir);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    log.warn('[toolSummarizer] cleanup sweep failed', e);
    return;
  }
  if (deletedFiles > 0) {
    log.info(
      `[toolSummarizer] cleanup deleted ${deletedFiles} archived tool result file(s) totaling ${(deletedBytes / 1024).toFixed(1)} KiB (>${CLEANUP_AGE_DAYS}d old)`
    );
  }
}
