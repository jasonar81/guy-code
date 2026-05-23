import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';

interface Props {
  label: string;
  count: number;
  defaultOpen?: boolean;
  emphasis?: 'attention' | 'normal';
  children: ReactNode;
}

export function Section({ label, count, defaultOpen = true, emphasis = 'normal', children }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="select-none">
      <button
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'w-full flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider',
          emphasis === 'attention' ? 'text-state-attention' : 'text-text-dim',
          'hover:text-text'
        )}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="flex-1 text-left">{label}</span>
        <span className="font-mono text-text-dim">{count}</span>
      </button>
      {open && <div className="flex flex-col">{children}</div>}
    </div>
  );
}
