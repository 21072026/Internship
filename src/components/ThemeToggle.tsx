'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useT } from '@/i18n/client';

type Theme = 'light' | 'dark';

// Light/dark toggle. Persists to localStorage + a cookie (so SSR + the no-flash
// script agree) and, when signed in, to the user's saved preference.
export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    try { localStorage.setItem('theme', next); } catch { /* ignore */ }
    document.cookie = `theme=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    // Best-effort persist to the account (ignored / 401 when signed out).
    fetch('/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }),
    }).catch(() => {});
  };

  return (
    <button
      type="button"
      onClick={() => apply(theme === 'dark' ? 'light' : 'dark')}
      aria-label={t.theme.toggle}
      title={t.theme.toggle}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span>{theme === 'dark' ? t.theme.light : t.theme.dark}</span>
    </button>
  );
}
