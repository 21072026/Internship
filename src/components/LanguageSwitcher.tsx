'use client';

import { Languages } from 'lucide-react';
import { locales, type Locale, LOCALE_COOKIE } from '@/i18n/config';

export function LanguageSwitcher({ current }: { current: Locale }) {
  const set = async (locale: Locale) => {
    if (locale === current) return;
    // 1 year cookie; a full reload re-renders the server layout with the new locale.
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}`;
    // Persist as the per-user preference too (ignored / 401 when signed out).
    try {
      await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredLanguage: locale }),
      });
    } catch {
      // ignore — the cookie already applied the change
    }
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-1 text-xs" aria-label="Language">
      <Languages className="h-3.5 w-3.5 text-gray-400" />
      {locales.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => set(l)}
          className={`px-1.5 py-0.5 rounded uppercase transition-colors ${
            l === current ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:text-gray-800'
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
