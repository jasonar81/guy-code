import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'guycode.theme';

function applyTheme(t: Theme) {
  const html = document.documentElement;
  let dark: boolean;
  if (t === 'system') {
    dark = matchMedia('(prefers-color-scheme: dark)').matches;
  } else {
    dark = t === 'dark';
  }
  html.classList.toggle('dark', dark);
}

function readInitial(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'light';
}

export const useTheme = create<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}>((set, get) => ({
  theme: readInitial(),
  setTheme: (t) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    applyTheme(t);
    set({ theme: t });
  },
  toggle: () => {
    const cur = get().theme;
    const next: Theme = cur === 'dark' ? 'light' : 'dark';
    get().setTheme(next);
  },
}));

// Keep DOM in sync if `system` mode and OS theme changes.
if (typeof window !== 'undefined') {
  applyTheme(readInitial());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (useTheme.getState().theme === 'system') applyTheme('system');
  });
}
