// Memory loader: surfaces both Guy-owned memory (writable) and the imported
// Claude memory hierarchy (read-only) to the agent at session start, as a
// cached system block (slot 3 per design).
//
// Read paths, in priority order (earlier wins on cap and on dedup):
//   1. Guy global       ~/.guycode/memory/*.md
//   2. Guy per-project  ~/.guycode/projects/<projectId>/memory/*.md
//   3. CLAUDE.md walked up from cwd
//   4. ~/.claude/CLAUDE.md  (global Claude)
//   5. ~/.claude/projects/<slug>/memory/*.md  (matched to cwd)
//   6. ~/.claude/projects/*/memory/*.md  (fallback for cwd-less sessions)
//
// Write paths:
//   • Guy global / per-project memory under ~/.guycode/...  ← saveMemory()
//   • We NEVER write to ~/.claude. That tree is treated as read-only import.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path';
import log from 'electron-log';

// 256KB total ≈ 64K tokens. Large enough to hold a substantial memory tree
// (~99 reference / feedback / project leaves at typical sizes) while still
// leaving plenty of room in Claude's 200K-token window for live work.
// Memory contents are prompt-cached after the first turn, so per-turn cost
// stays low even at this size.
const MAX_TOTAL_MEMORY_BYTES = 256 * 1024;
// Cap one giant leaf so it can't eat the whole budget by itself. Applies to
// pinned leaves (which are uncapped in spirit but still get a sanity ceiling)
// and to Claude imports.
const MAX_PER_FILE_BYTES = 64 * 1024;
// Tighter per-file cap for non-pinned Guy leaves (normal + archived). A
// single 64KB per-task state dump used to evict ~15-20 small permanent
// rules; 16KB means even a runaway leaf can't starve the budget, and it
// nudges toward consolidating finished sagas into short outcomes.
const NONPINNED_PER_FILE_BYTES = 16 * 1024;
// A non-pinned Guy leaf untouched for longer than this is treated as
// archived (lowest load priority) even if its frontmatter doesn't say so.
// Editing the leaf refreshes its mtime, which automatically promotes it
// back to `normal` — that's how "unarchive on write" works for free.
const STALE_ARCHIVE_DAYS = 14;

/**
 * Memory load tiers. Higher tiers load first and are harder to evict.
 *   - pinned:   permanent always-applies rules (conventions, safety rules,
 *               durable workflow). Always loaded first; never auto-archived;
 *               not subject to the tight non-pinned per-file cap.
 *   - normal:   active / recent task state. Loaded after pinned, newest
 *               first, until the budget runs out.
 *   - archived: completed-task state. Loaded last (only if budget remains),
 *               but kept on disk and fully searchable via recall_memory.
 */
export type MemoryTier = 'pinned' | 'normal' | 'archived';

/**
 * Read the EXPLICIT tier from a leaf's frontmatter `priority:` field, if
 * present. Returns null when the file has no frontmatter or no priority
 * line (the common case for older leaves) — callers then fall back to the
 * staleness rule. Tolerant of unreadable / malformed files.
 */
export function readExplicitTier(path: string): MemoryTier | null {
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.startsWith('---')) return null;
    const end = text.indexOf('\n---', 3);
    if (end === -1) return null;
    const fm = text.slice(3, end);
    const raw = /^\s*priority:\s*(.*)$/m.exec(fm)?.[1]?.trim()?.toLowerCase();
    if (raw === 'pinned' || raw === 'normal' || raw === 'archived') return raw;
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute the EFFECTIVE tier of a Guy-owned leaf at load time, combining the
 * explicit frontmatter tier with the staleness rule. No file writes happen
 * here — auto-archive is a pure computation, so it never churns the mtime it
 * depends on.
 *
 *   pinned    → if frontmatter says pinned (sticky; staleness never demotes).
 *   archived  → if frontmatter says archived, OR (not pinned AND the leaf is
 *               older than STALE_ARCHIVE_DAYS).
 *   normal    → otherwise.
 */
export function getEffectiveTier(path: string, mtimeMs: number): MemoryTier {
  const explicit = readExplicitTier(path);
  if (explicit === 'pinned') return 'pinned';
  if (explicit === 'archived') return 'archived';
  const ageDays = (Date.now() - mtimeMs) / (1000 * 60 * 60 * 24);
  if (ageDays > STALE_ARCHIVE_DAYS) return 'archived';
  return 'normal';
}

/** Numeric rank for sorting: pinned(0) loads before normal(1) before archived(2). */
function tierRank(t: MemoryTier): number {
  return t === 'pinned' ? 0 : t === 'normal' ? 1 : 2;
}

export interface MemoryBundle {
  /** Concatenated, ready to drop into a system block. May be empty. */
  text: string;
  /** Absolute paths of files included, for transparency / logging. */
  sources: string[];
  /** Bytes truncated due to caps (zero if everything fit). */
  truncatedBytes: number;
}

/**
 * Walk from `start` upward to the filesystem root, collecting CLAUDE.md
 * files in order (deepest first, root last). Stops at root or `~`.
 */
function walkUpForClaudeMd(start: string): string[] {
  const found: string[] = [];
  const home = homedir();
  let cur = resolvePath(start);
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const candidate = join(cur, 'CLAUDE.md');
    if (existsSync(candidate)) found.push(candidate);
    const dotClaude = join(cur, '.claude', 'CLAUDE.md');
    if (existsSync(dotClaude)) found.push(dotClaude);
    if (cur === home) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

/**
 * Look for ~/.claude/projects/<slug>/memory/*.md leaves. The Claude Code
 * slug is e.g. `C--Users-jarnold-Downloads-guy-code` (drive + path with
 * separators flattened). We accept the slug (projectId) directly.
 *
 * Returned in load priority order:
 *   1. `MEMORY.md` (the user's hand-curated index, if present)
 *   2. Non-project_* leaves (`reference_*`, `feedback_*`, `user_*`, etc.)
 *      sorted alphabetically — these are the focused single-topic docs
 *   3. `project_*` leaves sorted alphabetically — biggest noisy files last
 *      so they don't starve the budget for the substantive references.
 */
function findClaudeProjectMemory(projectIdSlug: string): string[] {
  if (!projectIdSlug || projectIdSlug.startsWith('__guy_')) return [];
  const memDir = join(homedir(), '.claude', 'projects', projectIdSlug, 'memory');
  if (!existsSync(memDir)) return [];
  try {
    const names = readdirSync(memDir).filter((n) => n.toLowerCase().endsWith('.md'));
    return prioritizeMemoryNames(memDir, names);
  } catch {
    return [];
  }
}

function prioritizeMemoryNames(memDir: string, names: string[]): string[] {
  const out: string[] = [];
  const lower = (s: string) => s.toLowerCase();
  const has = (n: string) => names.some((x) => lower(x) === lower(n));
  // 1. The user-curated index file goes first if it exists.
  if (has('MEMORY.md')) {
    out.push(join(memDir, names.find((x) => lower(x) === 'memory.md')!));
  }
  // 2. Non-project_* files — typically reference_*, feedback_*, user_*
  // (smaller, more focused). Alphabetical for stable ordering.
  const nonProject = names
    .filter((n) => lower(n) !== 'memory.md' && !lower(n).startsWith('project_'))
    .sort();
  for (const n of nonProject) out.push(join(memDir, n));
  // 3. project_* files last — these are big working notes, typically only
  // relevant to one project at a time. Alphabetical so order is stable.
  const projectFiles = names.filter((n) => lower(n).startsWith('project_')).sort();
  for (const n of projectFiles) out.push(join(memDir, n));
  return out;
}

/**
 * Sessions that aren't bound to a cwd (Guy's default) wouldn't otherwise pick
 * up any per-project memory at all. To keep the model anchored in the user's
 * accumulated context, we scan every `~/.claude/projects/<slug>/memory` leaf
 * and apply the same priority ordering as a cwd-bound load (MEMORY.md first,
 * then reference / feedback / user files alphabetical, then project_* last).
 * Within each category, leaves from the largest project (by total memory
 * volume) win — that's almost certainly the user's primary working tree.
 */
function findAllClaudeProjectMemory(): string[] {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsRoot)) return [];
  let slugs: string[] = [];
  try {
    slugs = readdirSync(projectsRoot);
  } catch {
    return [];
  }
  // Compute total memory bytes per project so we can prioritize the user's
  // primary working tree first.
  const projects: { slug: string; total: number; names: string[]; memDir: string }[] = [];
  for (const slug of slugs) {
    const memDir = join(projectsRoot, slug, 'memory');
    if (!existsSync(memDir)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(memDir).filter((n) => n.toLowerCase().endsWith('.md'));
    } catch {
      continue;
    }
    if (names.length === 0) continue;
    let total = 0;
    for (const n of names) {
      try {
        total += statSync(join(memDir, n)).size;
      } catch {
        /* ignore */
      }
    }
    projects.push({ slug, total, names, memDir });
  }
  // Biggest project first.
  projects.sort((a, b) => b.total - a.total);
  // Then within each project, apply category-based priority ordering so the
  // index + curated reference docs precede the noisy project_* notes.
  const out: string[] = [];
  for (const p of projects) {
    for (const path of prioritizeMemoryNames(p.memDir, p.names)) {
      out.push(path);
    }
  }
  return out;
}

/** Read at most `cap` bytes from `path`; appends a truncation tag if cut. */
function readCapped(path: string, cap: number): { text: string; truncated: number } {
  try {
    const stat = statSync(path);
    if (stat.size <= cap) {
      return { text: readFileSync(path, 'utf8'), truncated: 0 };
    }
    const buf = readFileSync(path);
    const head = buf.slice(0, cap).toString('utf8');
    return {
      text: `${head}\n\n[... ${stat.size - cap} bytes truncated ...]`,
      truncated: stat.size - cap,
    };
  } catch (e) {
    log.warn(`[memory] read failed for ${path}`, e);
    return { text: '', truncated: 0 };
  }
}

// ---- Guy-owned memory paths (writable) ----------------------------------

/** Root directory for Guy's writable memory. Created lazily. */
function guyMemoryRoot(): string {
  return join(homedir(), '.guycode');
}

function guyGlobalMemoryDir(): string {
  return join(guyMemoryRoot(), 'memory');
}

function guyProjectMemoryDir(projectId: string): string {
  return join(guyMemoryRoot(), 'projects', projectId, 'memory');
}

function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

export function loadMemory(args: {
  cwd: string;
  projectId: string;
}): MemoryBundle {
  const { cwd, projectId } = args;
  const sources: string[] = [];
  const segments: string[] = [];
  let total = 0;
  let truncated = 0;

  // Helper: include a single file with the running cap. `perFileCap` lets
  // callers apply a tighter ceiling to non-pinned Guy leaves.
  const include = (p: string, perFileCap = MAX_PER_FILE_BYTES) => {
    if (sources.includes(p)) return;
    const remaining = MAX_TOTAL_MEMORY_BYTES - total;
    if (remaining <= 0) return;
    const cap = Math.min(perFileCap, remaining);
    const { text, truncated: t } = readCapped(p, cap);
    if (!text) return;
    sources.push(p);
    segments.push(`<<< ${p} >>>\n${text}`);
    total += text.length;
    truncated += t;
  };

  // 0. Guy-owned memory (writable), loaded FIRST so it wins the budget over
  // the read-only Claude imports. Within the Guy tree we load by TIER, not by
  // filename: pinned rules first (always, uncapped-ish), then normal task
  // state newest-first, then archived completed-task state last. This is the
  // fix for the eviction bug where small permanent rules (worktree workflow,
  // never-* rules, release workflow) lost the alphabetical lottery to large
  // dead per-task state dumps and never reached the model's context.
  {
    const guyPaths: string[] = [
      ...listMdFiles(guyGlobalMemoryDir()),
      ...(projectId ? listMdFiles(guyProjectMemoryDir(projectId)) : []),
    ];
    // Stat once; compute effective tier from frontmatter + staleness.
    const entries = guyPaths
      .map((p) => {
        try {
          const st = statSync(p);
          return { path: p, mtime: st.mtimeMs, tier: getEffectiveTier(p, st.mtimeMs) };
        } catch {
          return null;
        }
      })
      .filter((e): e is { path: string; mtime: number; tier: MemoryTier } => e !== null);
    // Sort: tier rank asc (pinned→normal→archived), then mtime desc (newest
    // first within a tier). Pinned therefore always precedes everything and
    // is included before the budget can be consumed by anything else.
    entries.sort((a, b) => {
      const r = tierRank(a.tier) - tierRank(b.tier);
      if (r !== 0) return r;
      return b.mtime - a.mtime;
    });
    for (const e of entries) {
      const perFileCap =
        e.tier === 'pinned' ? MAX_PER_FILE_BYTES : NONPINNED_PER_FILE_BYTES;
      include(e.path, perFileCap);
    }
  }

  // 1. Project-level CLAUDE.md (walked from cwd up). Only if cwd is real.
  if (cwd && cwd.trim()) {
    for (const p of walkUpForClaudeMd(cwd)) include(p);
  }

  // 2. Global ~/.claude/CLAUDE.md (always, if present and not already loaded).
  const globalClaude = join(homedir(), '.claude', 'CLAUDE.md');
  if (existsSync(globalClaude) && !sources.includes(globalClaude)) {
    const remaining = MAX_TOTAL_MEMORY_BYTES - total;
    if (remaining > 0) {
      const cap = Math.min(MAX_PER_FILE_BYTES, remaining);
      const { text, truncated: t } = readCapped(globalClaude, cap);
      if (text) {
        sources.push(globalClaude);
        segments.push(`<<< ${globalClaude} >>>\n${text}`);
        total += text.length;
        truncated += t;
      }
    }
  }

  // 3. Claude project-memory leaves for THIS session's project (if cwd-bound).
  const memFiles = findClaudeProjectMemory(projectId);
  for (const p of memFiles) {
    const remaining = MAX_TOTAL_MEMORY_BYTES - total;
    if (remaining <= 0) break;
    const cap = Math.min(MAX_PER_FILE_BYTES, remaining);
    const { text, truncated: t } = readCapped(p, cap);
    if (!text) continue;
    sources.push(p);
    segments.push(`<<< ${p} >>>\n${text}`);
    total += text.length;
    truncated += t;
  }

  // 4. Cwd-less sessions get nothing from steps 1 and 3, which would leave
  // the model completely amnesiac. Fall back to scanning ALL imported
  // Claude project memories, biggest first, until we run out of budget.
  // This makes a freshly-opened Guy session inherit the user's accumulated
  // working context the way Claude Code does when launched from a known dir.
  const cwdLess = !cwd || !cwd.trim() || projectId.startsWith('__guy_');
  if (cwdLess) {
    for (const p of findAllClaudeProjectMemory()) {
      if (sources.includes(p)) continue;
      const remaining = MAX_TOTAL_MEMORY_BYTES - total;
      if (remaining <= 0) break;
      const cap = Math.min(MAX_PER_FILE_BYTES, remaining);
      const { text, truncated: t } = readCapped(p, cap);
      if (!text) continue;
      sources.push(p);
      segments.push(`<<< ${p} >>>\n${text}`);
      total += text.length;
      truncated += t;
    }
  }

  if (segments.length === 0) {
    return { text: '', sources: [], truncatedBytes: 0 };
  }

  const header =
    `Project memory loaded at session start from these sources, in priority order. ` +
    `Guy-owned (\`~/.guycode/...\`) files are WRITABLE via the save_memory tool. ` +
    `Imported Claude files (\`~/.claude/...\`) are READ-ONLY \u2014 never edit those. ` +
    `Use these for style, conventions, and prior decisions; treat them as authoritative context.`;
  return {
    text: `${header}\n\n${segments.join('\n\n')}`,
    sources,
    truncatedBytes: truncated,
  };
}

// ---- Write API ----------------------------------------------------------

/** Maximum bytes we'll accept for a single saved memory leaf. */
const MAX_MEMORY_WRITE_BYTES = 64 * 1024;

/** Allowed chars in a memory key: turns into a filename. */
function sanitizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export interface SaveMemoryResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  error?: string;
}

/**
 * Insert or update a `priority:` line inside a leaf's YAML frontmatter,
 * returning the new full text. If the content has no frontmatter block, one
 * is created with just the priority line. Preserves all existing frontmatter
 * keys and the body verbatim. Used by saveMemory (when a priority arg is
 * passed) and by setMemoryPriority.
 */
export function upsertPriorityFrontmatter(content: string, priority: MemoryTier): string {
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = content.slice(3, end); // between the opening --- and closing ---
      const rest = content.slice(end); // starts at "\n---"
      let newFm: string;
      if (/^[ \t]*priority:[ \t]*.*$/m.test(fm)) {
        newFm = fm.replace(/^[ \t]*priority:[ \t]*.*$/m, `priority: ${priority}`);
      } else {
        // Append the priority line at the end of the existing frontmatter.
        newFm = `${fm.replace(/\s*$/, '')}\npriority: ${priority}\n`;
      }
      return `---${newFm}${rest}`;
    }
    // Malformed frontmatter (opening --- but no close): fall through and
    // prepend a fresh block so we never corrupt the file further.
  }
  return `---\npriority: ${priority}\n---\n\n${content}`;
}

/**
 * Persist a memory leaf under Guy's writable tree. Scope chooses the target:
 *   - 'global'  → ~/.guycode/memory/<key>.md
 *   - 'project' → ~/.guycode/projects/<projectId>/memory/<key>.md
 *
 * Mode controls how the file is updated:
 *   - 'replace' (default): overwrite existing content
 *   - 'append':            add a divider + new content to the end
 *
 * We never touch ~/.claude — that tree is read-only by design.
 */
export function saveMemory(args: {
  scope: 'global' | 'project';
  key: string;
  content: string;
  mode?: 'replace' | 'append';
  projectId?: string;
  /**
   * Optional load tier. When omitted on a REPLACE of an existing leaf, the
   * leaf's current explicit tier (if any) is preserved. When omitted on a
   * new leaf, the leaf defaults to `normal` (no frontmatter written).
   */
  priority?: MemoryTier;
}): SaveMemoryResult {
  const { scope, content, mode = 'replace', projectId, priority } = args;
  const key = sanitizeKey(args.key);
  if (!key) return { ok: false, error: 'invalid key (must contain letters/digits)' };
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, error: 'content is empty' };
  }
  if (content.length > MAX_MEMORY_WRITE_BYTES) {
    return {
      ok: false,
      error: `content exceeds limit (${content.length} > ${MAX_MEMORY_WRITE_BYTES} bytes)`,
    };
  }

  let dir: string;
  if (scope === 'global') {
    dir = guyGlobalMemoryDir();
  } else {
    if (!projectId || !projectId.trim()) {
      return { ok: false, error: 'project scope requires a non-empty projectId' };
    }
    dir = guyProjectMemoryDir(projectId);
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    return { ok: false, error: `mkdir failed: ${e?.message ?? e}` };
  }

  const path = join(dir, `${key}.md`);
  // Defense-in-depth: even though sanitizeKey strips path separators, double
  // check we're writing inside the intended dir.
  if (!resolvePath(path).startsWith(resolvePath(dir))) {
    return { ok: false, error: 'refusing to write outside memory dir' };
  }
  // And we never write into ~/.claude.
  if (resolvePath(path).startsWith(resolvePath(join(homedir(), '.claude')))) {
    return { ok: false, error: 'refusing to write under ~/.claude (read-only import)' };
  }

  try {
    let final = content;
    if (mode === 'append' && existsSync(path)) {
      const existing = readFileSync(path, 'utf8');
      const stamp = new Date().toISOString();
      final = `${existing.trimEnd()}\n\n---\n<!-- appended ${stamp} -->\n${content}`;
    }
    // Resolve the tier to stamp. Explicit arg wins. Otherwise, on a replace/
    // append of an existing leaf, preserve whatever explicit tier it already
    // had (so editing a pinned rule keeps it pinned without re-passing the
    // arg). A brand-new leaf with no arg gets no frontmatter (defaults to
    // `normal` via the loader's staleness logic).
    const tierToStamp: MemoryTier | null =
      priority ?? (existsSync(path) ? readExplicitTier(path) : null);
    if (tierToStamp) {
      // For append mode we just appended to `existing` which may already have
      // frontmatter; upsert handles both the has-frontmatter and no-frontmatter
      // cases idempotently.
      final = upsertPriorityFrontmatter(final, tierToStamp);
    }
    if (final.length > MAX_MEMORY_WRITE_BYTES) {
      return {
        ok: false,
        error: `file would exceed limit (${final.length} > ${MAX_MEMORY_WRITE_BYTES} bytes)`,
      };
    }
    writeFileSync(path, final, 'utf8');
    log.info(`[memory] saved ${scope} memory ${key} (${final.length}b) -> ${path}`);
    return { ok: true, path, bytes: final.length };
  } catch (e: any) {
    return { ok: false, error: `write failed: ${e?.message ?? e}` };
  }
}

export interface SetPriorityResult {
  ok: boolean;
  path?: string;
  priority?: MemoryTier;
  error?: string;
}

/**
 * Set the explicit load tier of an existing Guy-owned leaf by upserting its
 * frontmatter `priority:` line. This is the manual pin / archive / unarchive
 * control (the automatic side is the staleness rule in getEffectiveTier).
 *
 * Preserves the file's mtime so that toggling tier does NOT reset the
 * staleness clock — important when un-archiving: a leaf set back to `normal`
 * keeps its true age, so if it's still old the staleness rule can re-archive
 * it, and if it was recently worked on it stays active. (Editing CONTENT via
 * saveMemory is the thing that legitimately refreshes mtime / unarchives.)
 *
 * Refuses to write under ~/.claude (read-only import tree).
 */
export function setMemoryPriority(args: {
  scope: 'global' | 'project';
  key: string;
  priority: MemoryTier;
  projectId?: string;
}): SetPriorityResult {
  const { scope, priority, projectId } = args;
  const key = sanitizeKey(args.key);
  if (!key) return { ok: false, error: 'invalid key' };
  if (priority !== 'pinned' && priority !== 'normal' && priority !== 'archived') {
    return { ok: false, error: `invalid priority '${priority}'` };
  }
  const dir = scope === 'global' ? guyGlobalMemoryDir() : guyProjectMemoryDir(projectId ?? '');
  if (scope === 'project' && (!projectId || !projectId.trim())) {
    return { ok: false, error: 'project scope requires a non-empty projectId' };
  }
  const path = join(dir, `${key}.md`);
  if (resolvePath(path).startsWith(resolvePath(join(homedir(), '.claude')))) {
    return { ok: false, error: 'refusing to write under ~/.claude (read-only import)' };
  }
  if (!existsSync(path)) return { ok: false, error: `no such memory leaf: ${key}` };
  try {
    const original = readFileSync(path, 'utf8');
    const updated = upsertPriorityFrontmatter(original, priority);
    if (updated === original) {
      return { ok: true, path, priority }; // already at that tier
    }
    // Preserve mtime so changing tier doesn't lie about staleness.
    let prevMtime: Date | null = null;
    try {
      prevMtime = statSync(path).mtime;
    } catch {
      /* ignore */
    }
    writeFileSync(path, updated, 'utf8');
    if (prevMtime) {
      try {
        utimesSync(path, prevMtime, prevMtime);
      } catch {
        /* best-effort */
      }
    }
    log.info(`[memory] set priority of ${scope} memory ${key} -> ${priority}`);
    return { ok: true, path, priority };
  } catch (e: any) {
    return { ok: false, error: `write failed: ${e?.message ?? e}` };
  }
}

/**
 * Enumerate Guy-owned memory leaves for a scope. Returns absolute paths,
 * sizes, last-modified timestamps, and effective/explicit tier for display
 * in the memory tool's `list` mode.
 */
export interface GuyMemoryRow {
  path: string;
  scope: 'global' | 'project';
  bytes: number;
  mtime: number;
  /** Effective tier the loader will use (explicit frontmatter + staleness). */
  tier: MemoryTier;
  /** Explicit frontmatter tier, or null if it relies on staleness/default. */
  explicitTier: MemoryTier | null;
}

export function listGuyMemory(args: {
  scope: 'global' | 'project' | 'all';
  projectId?: string;
}): GuyMemoryRow[] {
  const out: GuyMemoryRow[] = [];
  const push = (p: string, scope: 'global' | 'project') => {
    try {
      const st = statSync(p);
      out.push({
        path: p,
        scope,
        bytes: st.size,
        mtime: st.mtimeMs,
        tier: getEffectiveTier(p, st.mtimeMs),
        explicitTier: readExplicitTier(p),
      });
    } catch {
      /* ignore */
    }
  };
  if (args.scope === 'global' || args.scope === 'all') {
    for (const p of listMdFiles(guyGlobalMemoryDir())) push(p, 'global');
  }
  if ((args.scope === 'project' || args.scope === 'all') && args.projectId) {
    for (const p of listMdFiles(guyProjectMemoryDir(args.projectId))) push(p, 'project');
  }
  return out;
}

/**
 * Enumerate the read-only Claude-import memory leaves the loader would
 * consider for THIS session, so `list_memory` can surface them too.
 *
 * Why this exists: `list_memory` historically showed ONLY Guy-owned leaves
 * under `~/.guycode`. That meant a model orienting itself ("what reference /
 * feedback docs do I have?") was blind to the imported `~/.claude` tree —
 * which is where authoritative checklists like the pre-PR hardening
 * reference live. A real bug followed from this: the hardening doc was
 * skipped because nothing surfaced it on the trigger word. Discovery should
 * not depend on which tree a leaf lives in.
 *
 * This returns the SAME set the session-start loader walks (global
 * CLAUDE.md, the cwd-matched project memory, and — for cwd-less Guy
 * sessions — the cross-project fallback), each with its parsed `name` /
 * `description` frontmatter so the trigger text is visible in the listing.
 * Read-only: these are never writable via save/delete.
 *
 * Note this lists by the loader's discovery rules, NOT by what actually fit
 * under the load cap — so even a leaf that got truncated/dropped from the
 * in-context bundle is still discoverable here (the model can then `Read`
 * it directly by path).
 */
export function listClaudeMemory(args: {
  cwd: string;
  projectId?: string;
}): {
  path: string;
  name: string | null;
  description: string | null;
  bytes: number;
  mtime: number;
}[] {
  const { cwd } = args;
  const projectId = args.projectId ?? '';
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };

  // Mirror loadMemory's ~/.claude discovery order (steps 1–4 there), minus
  // the Guy-owned dirs which listGuyMemory already covers.
  if (cwd && cwd.trim()) {
    for (const p of walkUpForClaudeMd(cwd)) add(p);
  }
  const globalClaude = join(homedir(), '.claude', 'CLAUDE.md');
  if (existsSync(globalClaude)) add(globalClaude);
  for (const p of findClaudeProjectMemory(projectId)) add(p);
  const cwdLess = !cwd || !cwd.trim() || projectId.startsWith('__guy_');
  if (cwdLess) {
    for (const p of findAllClaudeProjectMemory()) add(p);
  }

  const out: {
    path: string;
    name: string | null;
    description: string | null;
    bytes: number;
    mtime: number;
  }[] = [];
  for (const p of paths) {
    try {
      const st = statSync(p);
      const meta = parseMdFrontmatter(p);
      out.push({
        path: p,
        name: meta.name,
        description: meta.description,
        bytes: st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      /* ignore unreadable */
    }
  }
  return out;
}

/**
 * Delete a Guy-owned memory leaf. Refuses any path that resolves outside
 * Guy's writable tree.
 */
export function deleteGuyMemory(args: {
  scope: 'global' | 'project';
  key: string;
  projectId?: string;
}): { ok: boolean; error?: string } {
  const key = sanitizeKey(args.key);
  if (!key) return { ok: false, error: 'invalid key' };
  const dir =
    args.scope === 'global'
      ? guyGlobalMemoryDir()
      : args.projectId
        ? guyProjectMemoryDir(args.projectId)
        : null;
  if (!dir) return { ok: false, error: 'project scope requires projectId' };
  const path = join(dir, `${key}.md`);
  if (!resolvePath(path).startsWith(resolvePath(dir))) {
    return { ok: false, error: 'refusing to delete outside memory dir' };
  }
  if (!existsSync(path)) return { ok: false, error: 'not found' };
  try {
    unlinkSync(path);
    log.info(`[memory] deleted ${args.scope} memory ${key} -> ${path}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: `delete failed: ${e?.message ?? e}` };
  }
}

/**
 * Lightweight on-demand recall. Substring match over loaded segments.
 * Returns matching paragraphs with file context. Used by the recall_memory
 * tool when the agent wants to look something up without loading the whole
 * tree into the prompt.
 */
export function recallFromBundle(
  bundle: MemoryBundle,
  query: string,
  maxResults = 8
): string {
  if (!bundle.text || !query.trim()) return '(no memory loaded or empty query)';
  const q = query.toLowerCase();
  const out: string[] = [];
  const segments = bundle.text.split(/\n\n(?=<<< )/g);
  for (const seg of segments) {
    const headerEnd = seg.indexOf('\n');
    const header = seg.slice(0, headerEnd);
    const body = seg.slice(headerEnd + 1);
    const paras = body.split(/\n{2,}/);
    for (const para of paras) {
      if (para.toLowerCase().includes(q)) {
        out.push(`${header}\n${para}`);
        if (out.length >= maxResults) break;
      }
    }
    if (out.length >= maxResults) break;
  }
  return out.length === 0 ? `(no matches for "${query}")` : out.join('\n\n---\n\n');
}

/**
 * Search ALL memory leaves ON DISK for a substring, NOT just the ones that
 * fit in the session-load bundle. This is what makes archived (and otherwise
 * evicted-by-budget) content findable: recall must see the full tree, or the
 * whole point of "archived is still searchable" fails.
 *
 * Scans every Guy-owned leaf (global + this project) regardless of tier, plus
 * the Claude-import leaves the loader would consider, reads each from disk,
 * and returns matching paragraphs tagged with their source path and tier.
 * Bounded by design — the whole tree is on the order of a couple MB.
 */
export function recallFromDisk(args: {
  cwd: string;
  projectId?: string;
  query: string;
  maxResults?: number;
}): string {
  const { cwd, projectId, query } = args;
  const maxResults = args.maxResults ?? 8;
  if (!query.trim()) return '(empty query)';
  const q = query.toLowerCase();

  // Collect candidate paths: all Guy leaves (every tier) + Claude leaves.
  const guyPaths = [
    ...listMdFiles(guyGlobalMemoryDir()),
    ...(projectId ? listMdFiles(guyProjectMemoryDir(projectId)) : []),
  ];
  const claudePaths = listClaudeMemory({ cwd, projectId }).map((r) => r.path);
  // Search Guy leaves first (writable, usually more task-relevant), then Claude.
  const all = [...guyPaths, ...claudePaths];

  const out: string[] = [];
  for (const p of all) {
    if (out.length >= maxResults) break;
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if (!text.toLowerCase().includes(q)) continue;
    // Annotate Guy leaves with their effective tier so the caller can see
    // when a hit comes from archived state.
    let tierTag = '';
    try {
      if (guyPaths.includes(p)) {
        const st = statSync(p);
        tierTag = ` [${getEffectiveTier(p, st.mtimeMs)}]`;
      } else {
        tierTag = ' [claude-import]';
      }
    } catch {
      /* ignore */
    }
    const paras = text.split(/\n{2,}/);
    for (const para of paras) {
      if (para.toLowerCase().includes(q)) {
        out.push(`<<< ${p}${tierTag} >>>\n${para.trim()}`);
        if (out.length >= maxResults) break;
      }
    }
  }
  return out.length === 0 ? `(no matches for "${query}")` : out.join('\n\n---\n\n');
}

/** Extract the Claude project slug for a known cwd, mimicking Claude Code. */
export function claudeSlugForCwd(cwd: string): string {
  if (!cwd) return '';
  // Drive letter colon → dash. All separators → dash.
  return cwd.replace(/:/g, '').replace(/[\\/]/g, '-');
}

/** Look for skill / command markdown files under ~/.claude. */
export function listClaudeSkills(): { path: string; name: string; description: string | null }[] {
  const out: { path: string; name: string; description: string | null }[] = [];
  const roots = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.claude', 'commands'),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walkSkills(root, out);
  }
  return out;
}

function walkSkills(
  dir: string,
  out: { path: string; name: string; description: string | null }[]
) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      // Look for SKILL.md inside the directory (anthropic/skill convention).
      const skillFile = join(full, 'SKILL.md');
      if (existsSync(skillFile)) {
        const meta = parseMdFrontmatter(skillFile);
        out.push({ path: skillFile, name: meta.name ?? e.name, description: meta.description });
      } else {
        walkSkills(full, out);
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      const meta = parseMdFrontmatter(full);
      out.push({
        path: full,
        name: meta.name ?? parsePath(e.name).name,
        description: meta.description,
      });
    }
  }
}

export function parseMdFrontmatter(path: string): { name: string | null; description: string | null } {
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.startsWith('---')) {
      const firstLine = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
      return { name: null, description: firstLine ? firstLine.slice(0, 200) : null };
    }
    const end = text.indexOf('\n---', 3);
    if (end === -1) return { name: null, description: null };
    const fm = text.slice(3, end);
    const desc = /^\s*description:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? null;
    const name = /^\s*name:\s*(.*)$/m.exec(fm)?.[1]?.trim() ?? null;
    return { name, description: desc };
  } catch {
    return { name: null, description: null };
  }
}
