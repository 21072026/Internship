'use client';

import { useEffect, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useT } from '@/i18n/client';

type FontSize = 'sm' | 'md' | 'lg' | 'xl';
const SIZES: FontSize[] = ['sm', 'md', 'lg', 'xl'];

// Global font-size stepper (small/normal/large/extra-large). Persists to
// localStorage + a cookie (SSR + no-flash script agree) and, when signed in,
// to the account — same pattern as ThemeToggle.
export function FontSizeControl() {
  const t = useT();
  const [size, setSize] = useState<FontSize>('md');

  useEffect(() => {
    const h = document.documentElement;
    const current = SIZES.find((s) => s !== 'md' && h.classList.contains(`font-${s}`));
    setSize(current ?? 'md');
  }, []);

  const apply = (next: FontSize) => {
    setSize(next);
    const h = document.documentElement;
    SIZES.forEach((s) => h.classList.remove(`font-${s}`));
    if (next !== 'md') h.classList.add(`font-${next}`);
    try { localStorage.setItem('fontSize', next); } catch { /* ignore */ }
    document.cookie = `fontSize=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    // Best-effort persist to the account (ignored / 401 when signed out).
    fetch('/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fontSize: next }),
    }).catch(() => {});
  };

  const index = SIZES.indexOf(size);
  const label = { sm: t.fontSize.small, md: t.fontSize.medium, lg: t.fontSize.large, xl: t.fontSize.extraLarge }[size];

  return (
    <div className="inline-flex items-center gap-1 rounded-lg px-1 py-1 text-xs text-gray-500 dark:text-gray-400">
      <button
        type="button"
        onClick={() => apply(SIZES[Math.max(0, index - 1)])}
        disabled={index === 0}
        aria-label={t.fontSize.decrease}
        title={t.fontSize.decrease}
        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-[3.5rem] text-center select-none">{label}</span>
      <button
        type="button"
        onClick={() => apply(SIZES[Math.min(SIZES.length - 1, index + 1)])}
        disabled={index === SIZES.length - 1}
        aria-label={t.fontSize.increase}
        title={t.fontSize.increase}
        className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-100 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
