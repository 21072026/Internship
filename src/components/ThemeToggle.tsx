'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useT } from '@/i18n/client';
import { THEME_CYCLE, applyTheme, readStoredTheme, type Theme } from '@/lib/theme';

// System/light/dark toggle. Persists to localStorage + a cookie (so SSR + the
// no-flash script agree) and, when signed in, to the user's saved preference.
// The state is read back from the stored value rather than from the `dark`
// class, which cannot tell "the user chose dark" from "the OS is dark" (#2078).
// Following a live OS switch on `system` is SystemThemeSync's job — it is
// mounted app-wide, including on pages that render no toggle.
export function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  const apply = (next: Theme) => {
    setTheme(next);
    applyTheme(next);
    // Best-effort persist to the account (ignored / 401 when signed out).
    fetch('/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: next }),
    }).catch(() => {});
  };

  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];
  const label: Record<Theme, string> = { system: t.theme.system, light: t.theme.light, dark: t.theme.dark };
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  // Keeps "toggle theme" in the accessible name (what the control does) and
  // adds the current state plus what the next click switches to.
  const ariaLabel = `${t.theme.toggle}: ${label[theme]} (${t.theme.next}: ${label[next]})`;

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      data-theme={theme}
      onClick={() => apply(next)}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 transition-colors"
    >
      <Icon className="h-4 w-4" />
      <span>{label[theme]}</span>
    </button>
  );
}
