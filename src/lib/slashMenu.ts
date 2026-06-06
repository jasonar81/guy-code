/**
 * Pure helpers for the Composer's slash-command autocomplete menu.
 *
 * Kept in `src/lib/` (not in the component file) so the matching /
 * filtering logic is unit-testable without rendering React. The
 * Composer wires these up to the textarea's value + selectionStart
 * and renders `SlashCommandMenu.tsx`.
 *
 * Behavior must MIRROR `parseSlashCommand` in `electron/skills.ts` —
 * the menu should only appear when the agent backend would actually
 * recognize the slash command. Otherwise the user types a slash, sees
 * a menu, picks something, and the agent ignores it because the parser
 * had a stricter rule. That confusion is worse than no menu at all.
 *
 * Stricter parser rules we replicate here:
 *   • Slash must come after optional leading whitespace only — if
 *     anything else precedes it on the line (or any prior content
 *     exists), no menu. This matches `text.trimStart().startsWith('/')`.
 *   • Second char must be a name char (rejects `/path`, `/ thing`,
 *     `//comment`).
 *   • Cursor must sit between the `/` and the first whitespace
 *     terminator (so once the user types a space, we know they've
 *     finished the command name and we hide the menu).
 */
import type { SkillSummary } from '@/types';

/**
 * Active slash-command slice info, returned by `detectSlashContext`.
 * `slashStart` and `queryEnd` are character indices in the original
 * text — used by `applySkillPick` to splice a chosen skill back into
 * the textarea without disturbing surrounding content.
 */
export interface SlashContext {
  /** Text after the `/` and up to the cursor. Empty when cursor is right after the slash. */
  query: string;
  /** Index of the `/` character in the original text. */
  slashStart: number;
  /** Index (exclusive) of the END of the command name in the original text. */
  queryEnd: number;
}

/**
 * Detect whether the cursor is currently inside an in-progress slash
 * command at the very top of the text buffer. Returns context info
 * if so; null when the menu should be hidden.
 */
export function detectSlashContext(text: string, cursor: number): SlashContext | null {
  // Find first non-whitespace char.
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '/') return null;
  const slashStart = i;
  const next = text[i + 1];
  // Reject `//foo` (comment-ish) and `/ thing` (slash then space). But a
  // BARE trailing `/` (next === undefined) IS valid: that's the user opening
  // the picker to browse the full alphabetical list because they can't
  // remember the skill name — the headline UX of this menu. It yields an
  // empty query, which filterSkills('') turns into the full sorted list.
  if (next === '/' || (next !== undefined && /\s/.test(next))) return null;
  // Walk to end of the command name (first whitespace/newline OR end).
  let j = i + 1;
  while (j < text.length && !/\s/.test(text[j])) j++;
  // Cursor must be inside [slashStart+1, j]. We allow == j so the menu
  // stays visible when the user hits the end of their typed query and
  // hasn't yet typed a separator. Once they type space/newline, j
  // advances past the cursor and we return null.
  if (cursor < slashStart + 1 || cursor > j) return null;
  const query = text.slice(slashStart + 1, cursor);
  // Reject queries containing path separators — `/foo/bar` should not
  // pop the menu after `bar`. detectSlashContext already prevents this
  // because `/` would have been caught as the second-char check, but
  // belt-and-suspenders for content that paste-arrived all at once.
  if (query.includes('/')) return null;
  return { query, slashStart, queryEnd: j };
}

/**
 * Match `query` against the skill list and return up to `limit` results
 * sorted by relevance:
 *   • Prefix match on name (best)
 *   • Substring match on name
 *   • Substring match on description (last)
 * Within each tier, results sort alphabetically by name. An empty
 * query returns the full list (up to limit), alphabetical.
 */
export function filterSkills(
  skills: SkillSummary[],
  query: string,
  limit = 30
): SkillSummary[] {
  if (!query) {
    return skills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  const q = query.toLowerCase();
  const scored: Array<{ tier: number; skill: SkillSummary }> = [];
  for (const s of skills) {
    const name = s.name.toLowerCase();
    if (name.startsWith(q)) scored.push({ tier: 0, skill: s });
    else if (name.includes(q)) scored.push({ tier: 1, skill: s });
    else if (s.description.toLowerCase().includes(q)) scored.push({ tier: 2, skill: s });
  }
  scored.sort(
    (a, b) => a.tier - b.tier || a.skill.name.localeCompare(b.skill.name)
  );
  return scored.slice(0, limit).map((x) => x.skill);
}

/**
 * Splice a chosen skill into the text buffer, replacing the partial
 * command name with the full one followed by a space. Returns the new
 * text and the new cursor position so the caller can update the
 * textarea selection programmatically.
 */
export function applySkillPick(
  text: string,
  ctx: SlashContext,
  skillName: string
): { newText: string; newCursor: number } {
  const replacement = `/${skillName} `;
  const newText = text.slice(0, ctx.slashStart) + replacement + text.slice(ctx.queryEnd);
  const newCursor = ctx.slashStart + replacement.length;
  return { newText, newCursor };
}
