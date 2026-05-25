/**
 * Floating dropdown rendered above the Composer's textarea when the
 * user types `/` at the start of a message. Mirrors the Claude
 * Desktop UX: list narrows as more letters are typed, ↑/↓ to move,
 * Enter/Tab to pick, Esc to dismiss.
 *
 * The component is purely presentational — all matching logic lives
 * in `src/lib/slashMenu.ts`. The Composer owns:
 *   • the textarea state (text + selection)
 *   • the cached skill list (one IPC call per session, see store.ts)
 *   • keyboard interception in the textarea's onKeyDown
 *
 * Props are deliberately minimal: pass the filtered list, the active
 * index, and callbacks. This keeps the component cheap to test and
 * impossible to miswire (the Composer can't accidentally show stale
 * results because there's no internal filter state).
 */
import clsx from 'clsx';
import type { SkillSummary } from '@/types';

interface Props {
  /** Skills to render, already filtered + ranked by `filterSkills`. */
  items: SkillSummary[];
  /** Currently highlighted index. -1 = nothing highlighted (dim header only). */
  activeIndex: number;
  /** User's current query (post-slash). Surfaced in the empty-state copy. */
  query: string;
  /** Click handler — picks the skill at `index`. */
  onPick: (index: number) => void;
  /** Hover handler — highlights the skill at `index`. */
  onHover: (index: number) => void;
}

const SOURCE_LABEL: Record<SkillSummary['source'], string> = {
  'guy-user': 'guy',
  'guy-project': 'guy/project',
  'claude-user': 'claude',
  'claude-project': 'claude/project',
  'claude-commands': 'claude/cmd',
};

const SOURCE_BADGE_TONE: Record<SkillSummary['source'], string> = {
  'guy-user': 'bg-accent/15 text-accent',
  'guy-project': 'bg-accent/15 text-accent',
  'claude-user': 'bg-text-dim/15 text-text-muted',
  'claude-project': 'bg-text-dim/15 text-text-muted',
  'claude-commands': 'bg-text-dim/15 text-text-muted',
};

export function SlashCommandMenu({ items, activeIndex, query, onPick, onHover }: Props) {
  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className={clsx(
        'absolute left-3 right-3 bottom-full mb-2 z-50',
        'rounded-md border border-border bg-bg-elevated shadow-lg',
        'max-h-72 overflow-y-auto'
      )}
      // Block mousedown so clicking an item doesn't blur the textarea
      // before our onClick fires.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-text-dim border-b border-border bg-bg-panel sticky top-0">
        {items.length === 0
          ? `No skills match "/${query}"`
          : `Skills · ${items.length} match${items.length === 1 ? '' : 'es'}`}
      </div>
      {items.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-text-muted">
          Type a different name, or press Esc to dismiss. Skills live in
          <code className="font-mono mx-1">~/.guycode/skills</code>
          and imported from your Claude environment.
        </div>
      ) : (
        <ul className="py-1">
          {items.map((skill, i) => (
            <li key={skill.name}>
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                onClick={() => onPick(i)}
                onMouseEnter={() => onHover(i)}
                className={clsx(
                  'w-full text-left px-3 py-1.5 flex items-start gap-2',
                  'focus:outline-none',
                  i === activeIndex
                    ? 'bg-accent/10'
                    : 'hover:bg-bg-hover'
                )}
              >
                <code
                  className={clsx(
                    'shrink-0 font-mono text-[12px] mt-px',
                    i === activeIndex ? 'text-accent' : 'text-text'
                  )}
                >
                  /{skill.name}
                </code>
                <span className="flex-1 min-w-0 text-[12px] text-text-muted truncate">
                  {skill.description}
                </span>
                <span
                  className={clsx(
                    'shrink-0 text-[9px] uppercase tracking-wide rounded px-1.5 py-0.5',
                    SOURCE_BADGE_TONE[skill.source]
                  )}
                >
                  {SOURCE_LABEL[skill.source]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
