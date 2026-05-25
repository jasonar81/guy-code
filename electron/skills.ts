/**
 * Skills loader and registry.
 *
 * A "skill" is a markdown file (typically `<dir>/SKILL.md`) with
 * YAML frontmatter declaring `name`, `description`, optionally
 * `tools`, plus a body of instructions the model should follow when
 * the skill is invoked. Anthropic introduced this format for Claude
 * Code; Guy Code reads the same shape.
 *
 * Discovery walks four locations in this priority order:
 *
 *   1. ~/.guycode/skills/             — Guy's own user-global skills
 *   2. <cwd>/.guycode/skills/         — per-project Guy skills
 *   3. <cwd>/.claude/skills/          — imported per-project from Claude
 *   4. ~/.claude/skills/              — imported user-global from Claude
 *
 * Plus the legacy `~/.claude/commands/` location for slash-command
 * markdown files (kept for back-compat with users who already had
 * commands defined there).
 *
 * Name collision policy: the FIRST hit wins. If `feature-spec` is
 * defined under both `~/.guycode/skills/` and `~/.claude/skills/`,
 * the Guy version wins and the Claude version is recorded in a
 * `shadowed` list (surfaced in Settings so users know).
 *
 * The model sees skills two ways:
 *   • System prompt block: a single "Available skills:" enumeration
 *     of `name → description`. Bodies are NOT injected (they'd blow
 *     up the system prompt at scale). The model picks a skill by
 *     name based on description match or explicit user request.
 *   • `Skill` tool: takes `SkillName`, returns the full SKILL.md body.
 *     The agent then operates with those instructions in its context.
 *
 * Slash-command invocation: a user message that begins with
 * `/skill-name [...args]` is rewritten by `parseSlashCommand` so the
 * model sees a synthetic instruction to invoke the named skill. See
 * `runUserTurn` in `electron/agent.ts`.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, parse as parsePath } from 'node:path';
import { homedir } from 'node:os';
import log from 'electron-log';

/**
 * Test seam to redirect `homedir()` resolution. ESM module namespaces
 * aren't configurable so vi.spyOn('os', 'homedir') fails; this lets
 * tests pin the home root directly. Pass null to restore the default.
 */
let _homeOverride: string | null = null;
export function _setHomeForTesting(path: string | null): void {
  _homeOverride = path;
}
function resolveHome(): string {
  return _homeOverride ?? homedir();
}

export interface Skill {
  /** The canonical name (from frontmatter or filename), no extension. */
  name: string;
  /** One-liner description; surfaces in the Available-skills system block. */
  description: string;
  /** Full markdown body INCLUDING frontmatter, returned by the Skill tool. */
  body: string;
  /** Absolute path to the SKILL.md (or *.md) file. */
  path: string;
  /** Directory that holds the skill + its supporting files. */
  dir: string;
  /** Where the skill was loaded from. */
  source: SkillSource;
}

export type SkillSource =
  | 'guy-user' // ~/.guycode/skills/
  | 'guy-project' // <cwd>/.guycode/skills/
  | 'claude-project' // <cwd>/.claude/skills/
  | 'claude-user' // ~/.claude/skills/
  | 'claude-commands'; // ~/.claude/commands/ (legacy slash-command location)

const SOURCE_PRIORITY: SkillSource[] = [
  'guy-user',
  'guy-project',
  'claude-project',
  'claude-user',
  'claude-commands',
];

interface ScanRoot {
  dir: string;
  source: SkillSource;
}

/** Returns the four+1 source roots for a session that may or may not have a cwd. */
function scanRoots(cwd?: string | null): ScanRoot[] {
  const home = resolveHome();
  const roots: ScanRoot[] = [
    { dir: join(home, '.guycode', 'skills'), source: 'guy-user' },
  ];
  if (cwd) {
    roots.push({ dir: join(cwd, '.guycode', 'skills'), source: 'guy-project' });
    roots.push({ dir: join(cwd, '.claude', 'skills'), source: 'claude-project' });
  }
  roots.push({ dir: join(home, '.claude', 'skills'), source: 'claude-user' });
  roots.push({ dir: join(home, '.claude', 'commands'), source: 'claude-commands' });
  return roots;
}

/**
 * Result of a registry load. `skills` are the live, name-deduped
 * entries; `shadowed` records every entry that lost a name collision
 * so Settings can show "this Claude skill is being eclipsed by a Guy
 * skill of the same name."
 */
export interface SkillRegistry {
  skills: Skill[];
  shadowed: Skill[];
}

/**
 * Load skills from all source locations and resolve name collisions.
 * Stable iteration order: skills are sorted by name; shadowed list
 * preserves load order (= source priority).
 */
export function loadSkills(cwd?: string | null): SkillRegistry {
  const found = new Map<string, Skill>(); // name -> winning skill
  const shadowed: Skill[] = [];
  for (const root of scanRoots(cwd)) {
    if (!existsSync(root.dir)) continue;
    let stat;
    try {
      stat = statSync(root.dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    walk(root.dir, root.source, (skill) => {
      const existing = found.get(skill.name);
      if (existing) {
        // The first-seen entry wins (priority order). Record the loser
        // in shadowed so Settings can flag it.
        shadowed.push(skill);
      } else {
        found.set(skill.name, skill);
      }
    });
  }
  const skills = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { skills, shadowed };
}

/**
 * Walk one root, identifying skills. Two layouts are recognized:
 *   • <root>/<name>/SKILL.md       — anthropic SKILL convention
 *   • <root>/<name>.md             — flat-file commands (legacy)
 *
 * Recurses into subdirectories that don't contain SKILL.md so a
 * deeply-nested layout is still discoverable. Cycles can't happen
 * (filesystems aren't graphs in this sense) but we cap recursion
 * depth defensively.
 */
function walk(dir: string, source: SkillSource, onSkill: (s: Skill) => void, depth = 0): void {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    log.warn(`[skills] readdir failed for ${dir}`, e);
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const skillFile = join(full, 'SKILL.md');
      if (existsSync(skillFile)) {
        const skill = readSkillFile(skillFile, full, source);
        if (skill) onSkill(skill);
      } else {
        walk(full, source, onSkill, depth + 1);
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      // Flat .md file = a command-style skill. Its dir is the parent.
      const skill = readSkillFile(full, dir, source);
      if (skill) onSkill(skill);
    }
  }
}

function readSkillFile(path: string, dir: string, source: SkillSource): Skill | null {
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch (e) {
    log.warn(`[skills] read failed for ${path}`, e);
    return null;
  }
  const fm = parseFrontmatter(body);
  // Filename-derived fallback name: SKILL.md → containing dir's name;
  // foo.md → "foo".
  const filenameStem = parsePath(path).name;
  const fallbackName =
    filenameStem.toLowerCase() === 'skill' ? parsePath(dir).name : filenameStem;
  const name = (fm.name ?? fallbackName).trim();
  const description = (fm.description ?? extractFirstLine(body) ?? '').trim();
  if (!name) return null;
  return { name, description, body, path, dir, source };
}

interface Frontmatter {
  name: string | null;
  description: string | null;
}

function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---')) return { name: null, description: null };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { name: null, description: null };
  const fm = text.slice(3, end);
  const get = (key: string): string | null => {
    // Single-line `key: value` only. Multi-line block scalars not
    // supported; SKILL.md description fields in the wild are short.
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'm').exec(fm);
    if (!m) return null;
    return stripQuotes(m[1].trim());
  };
  return { name: get('name'), description: get('description') };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'"))) {
    const q = s[0];
    if (s.endsWith(q)) return s.slice(1, -1);
  }
  return s;
}

function extractFirstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) continue;
    if (t === '---') continue;
    return t.length > 200 ? t.slice(0, 200) + '…' : t;
  }
  return null;
}

// ---------------------------------------------------------------------
// Slash-command parsing
// ---------------------------------------------------------------------

export interface SlashCommandMatch {
  /** The skill that the user message asks for. */
  skill: Skill;
  /** Anything after the slash command name on the first line. */
  args: string;
  /** The text BEFORE the slash command (extra context, usually empty). */
  preceding: string;
  /** The text AFTER the first line. */
  following: string;
}

/**
 * Recognize a leading `/skill-name [args]` in the user's message. The
 * slash MUST be the first non-whitespace character on the message and
 * MUST be followed by a non-`/` character (so `/usr/bin/foo` doesn't
 * trigger). Returns null when nothing matches.
 *
 * Args are everything on the same line after the skill name. Lines
 * after the first are returned in `following` so the user can pass
 * a multi-line context block to the skill, e.g.:
 *
 *     /feature-spec Carry-over budget model
 *     Focus on per-key isolation and edge cases at clock-hour boundaries.
 *     The user wants concrete walked examples.
 */
export function parseSlashCommand(
  text: string,
  registry: SkillRegistry
): SlashCommandMatch | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return null;
  // Reject path-y leads: `/usr/bin`, `//comment`, etc.
  if (trimmed.length < 2 || trimmed[1] === '/' || trimmed[1] === ' ') return null;
  // First line up to whitespace = potential command name.
  const newlineIdx = trimmed.indexOf('\n');
  const firstLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
  const tokenMatch = /^\/([A-Za-z0-9_.\-]+)/.exec(firstLine);
  if (!tokenMatch) return null;
  // Reject path-y forms after the command name: `/usr/bin/foo` would
  // otherwise match `usr` and treat the rest as args. The character
  // immediately after the name must be either end-of-line or
  // whitespace (real arg separator).
  const afterIdx = tokenMatch[0].length;
  if (afterIdx < firstLine.length && !/\s/.test(firstLine[afterIdx])) {
    return null;
  }
  const cmdName = tokenMatch[1];
  const skill = registry.skills.find((s) => s.name === cmdName);
  if (!skill) return null;
  const args = firstLine.slice(afterIdx).trim();
  const following = newlineIdx === -1 ? '' : trimmed.slice(newlineIdx + 1);
  const precedingLen = text.length - trimmed.length;
  const preceding = text.slice(0, precedingLen);
  return { skill, args, preceding, following };
}

/**
 * Build the user-facing message that replaces the original slash command
 * input. We surface the skill invocation explicitly so the model knows
 * to call its `Skill` tool with the matched name, and we forward the
 * args and following lines verbatim as user context.
 */
export function rewriteSlashCommand(match: SlashCommandMatch): string {
  const parts: string[] = [];
  parts.push(`Use the skill \`${match.skill.name}\` (${match.skill.description}).`);
  if (match.args) {
    parts.push(`Args / inline context: ${match.args}`);
  }
  if (match.following.trim()) {
    parts.push('');
    parts.push('Additional user context:');
    parts.push(match.following.trimEnd());
  }
  // Tell the model to fetch the body via the Skill tool — we don't
  // inline the body here because (a) it might be huge, and (b) the
  // tool call audit trail is more useful for debugging.
  parts.push('');
  parts.push(`Call the \`Skill\` tool with SkillName="${match.skill.name}" before doing anything else.`);
  return [match.preceding, parts.join('\n')].join('').trim();
}

// ---------------------------------------------------------------------
// System-prompt block
// ---------------------------------------------------------------------

/**
 * Render the "Available skills" section that gets injected into the
 * system prompt. Returns the empty string when no skills are loaded
 * so the prompt stays lean.
 *
 * Format chosen for terseness (every skill costs tokens on every
 * call): `- name: description`, one per line. The model identifies
 * the skill by name and invokes via the Skill tool.
 *
 * Sorted alphabetically by name for cache stability.
 */
export function renderSkillsBlock(registry: SkillRegistry): string {
  if (registry.skills.length === 0) return '';
  const lines: string[] = [];
  lines.push('Available skills (invoke via the Skill tool by exact name):');
  for (const s of registry.skills) {
    const desc = s.description.length > 220 ? s.description.slice(0, 220) + '…' : s.description;
    lines.push(`  • ${s.name}: ${desc}`);
  }
  lines.push('');
  lines.push(
    'A skill is a focused instruction set. When the user matches a skill\'s description, OR types a leading `/skill-name` slash command, OR explicitly asks "use the X skill", call the `Skill` tool with the exact name to fetch its full instructions, then follow them.'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// Helpers exposed to other modules
// ---------------------------------------------------------------------

/** Order labels for UI display ("Guy (user)", "Imported from Claude", etc.). */
export const SOURCE_LABELS: Record<SkillSource, string> = {
  'guy-user': 'Guy Code (user)',
  'guy-project': 'Guy Code (project)',
  'claude-project': 'Claude (project)',
  'claude-user': 'Claude (user)',
  'claude-commands': 'Claude commands',
};

/** Stable display-priority order, useful for grouping shadowed entries. */
export function sourcePriorityIndex(source: SkillSource): number {
  return SOURCE_PRIORITY.indexOf(source);
}
