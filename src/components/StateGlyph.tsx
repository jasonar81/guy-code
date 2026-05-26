import clsx from 'clsx';
import type { ProjectState } from '@/types';

const MAP: Record<ProjectState, { glyph: string; color: string; pulse?: boolean; title: string }> = {
  running: { glyph: '●', color: 'text-state-running', pulse: true, title: 'Running' },
  'waiting-on-system': { glyph: '◌', color: 'text-state-waiting', title: 'Waiting on system' },
  'waiting-on-user': { glyph: '⚠', color: 'text-state-attention', title: 'Needs you' },
  error: { glyph: '✗', color: 'text-state-error', title: 'Error' },
  idle: { glyph: '○', color: 'text-state-idle', title: 'Idle' },
  'sleeping-budget': { glyph: '💤', color: 'text-state-sleeping', title: 'Sleeping (budget)' },
  'sleeping-tool': { glyph: '⏳', color: 'text-state-sleeping', title: 'Sleeping (timer)' },
};

export function StateGlyph({ state }: { state: ProjectState }) {
  const m = MAP[state] ?? MAP.idle;
  return (
    <span
      title={m.title}
      className={clsx(
        'inline-block w-3 text-center text-[12px] leading-none',
        m.color,
        m.pulse && 'glyph-running'
      )}
      aria-label={m.title}
    >
      {m.glyph}
    </span>
  );
}
