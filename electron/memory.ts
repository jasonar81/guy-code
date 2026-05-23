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
// Cap one giant leaf so it can't eat the whole budget by itself.
const MAX_PER_FILE_BYTES = 64 * 1024;

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

  // Helper: include a single file with the running cap.
  const include = (p: string) => {
    if (sources.includes(p)) return;
    const remaining = MAX_TOTAL_MEMORY_BYTES - total;
    if (remaining <= 0) return;
    const cap = Math.min(MAX_PER_FILE_BYTES, remaining);
    const { text, truncated: t } = readCapped(p, cap);
    if (!text) return;
    sources.push(p);
    segments.push(`<<< ${p} >>>\n${text}`);
    total += text.length;
    truncated += t;
  };

  // 0a. Guy-owned global memory (writable). Loaded first so it wins under cap.
  for (const p of listMdFiles(guyGlobalMemoryDir())) include(p);

  // 0b. Guy-owned per-project memory. Always loaded if the projectId has any
  // (works for cwd-bound AND cwd-less Guy sessions — the projectId is stable).
  if (projectId) {
    for (const p of listMdFiles(guyProjectMemoryDir(projectId))) include(p);
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
}): SaveMemoryResult {
  const { scope, content, mode = 'replace', projectId } = args;
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
      if (final.length > MAX_MEMORY_WRITE_BYTES) {
        return {
          ok: false,
          error: `appended file would exceed limit (${final.length} > ${MAX_MEMORY_WRITE_BYTES} bytes)`,
        };
      }
    }
    writeFileSync(path, final, 'utf8');
    log.info(`[memory] saved ${scope} memory ${key} (${final.length}b) -> ${path}`);
    return { ok: true, path, bytes: final.length };
  } catch (e: any) {
    return { ok: false, error: `write failed: ${e?.message ?? e}` };
  }
}

/**
 * Enumerate Guy-owned memory leaves for a scope. Returns absolute paths,
 * sizes, and last-modified timestamps for display in the memory tool's
 * `list` mode.
 */
export function listGuyMemory(args: {
  scope: 'global' | 'project' | 'all';
  projectId?: string;
}): { path: string; scope: 'global' | 'project'; bytes: number; mtime: number }[] {
  const out: { path: string; scope: 'global' | 'project'; bytes: number; mtime: number }[] = [];
  if (args.scope === 'global' || args.scope === 'all') {
    for (const p of listMdFiles(guyGlobalMemoryDir())) {
      try {
        const st = statSync(p);
        out.push({ path: p, scope: 'global', bytes: st.size, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  if ((args.scope === 'project' || args.scope === 'all') && args.projectId) {
    for (const p of listMdFiles(guyProjectMemoryDir(args.projectId))) {
      try {
        const st = statSync(p);
        out.push({ path: p, scope: 'project', bytes: st.size, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
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
        const meta = parseSkillMd(skillFile);
        out.push({ path: skillFile, name: meta.name ?? e.name, description: meta.description });
      } else {
        walkSkills(full, out);
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      const meta = parseSkillMd(full);
      out.push({
        path: full,
        name: meta.name ?? parsePath(e.name).name,
        description: meta.description,
      });
    }
  }
}

function parseSkillMd(path: string): { name: string | null; description: string | null } {
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
