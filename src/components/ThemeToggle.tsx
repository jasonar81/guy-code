import { Sun, Moon, Monitor } from 'lucide-react';
import clsx from 'clsx';
import { useTheme, type Theme } from '@/lib/theme';

const OPTIONS: { v: Theme; icon: typeof Sun; label: string }[] = [
  { v: 'light', icon: Sun, label: 'Light' },
  { v: 'dark', icon: Moon, label: 'Dark' },
  { v: 'system', icon: Monitor, label: 'System' },
];

export function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);

  return (
    <div className="inline-flex items-center rounded-md border border-border overflow-hidden">
      {OPTIONS.map(({ v, icon: Icon, label }) => (
        <button
          key={v}
          onClick={() => setTheme(v)}
          title={label}
          className={clsx(
            'px-1.5 py-1 transition-colors',
            theme === v
              ? 'bg-bg-hover text-text'
              : 'text-text-dim hover:text-text hover:bg-bg-elevated'
          )}
          aria-label={`Theme: ${label}`}
          aria-pressed={theme === v}
        >
          <Icon size={12} />
        </button>
      ))}
    </div>
  );
}
