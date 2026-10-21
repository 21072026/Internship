'use client';

import { Languages } from 'lucide-react';
import { locales, type Locale, LOCALE_COOKIE } from '@/i18n/config';
import { isPrefixablePath, localizePath, splitLocalePrefix } from '@/lib/localePath';

// The control's own name, in the language it is currently showing. Kept here
// rather than in the dictionaries because the switcher renders on pages that
// sit outside the LocaleProvider (the public profile, #1386).
const SWITCHER_LABEL: Record<Locale, string> = { en: 'Language', tr: 'Dil', de: 'Sprache' };

export function LanguageSwitcher({ current }: { current: Locale }) {
  const set = (locale: Locale) => {
    if (locale === current) return;
    // Device-level override; a full reload re-renders the server layout. The
    // per-user saved preference is set deliberately from account settings.
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}`;
    // A public page has a URL per language (#1386): go to THIS page in the
    // chosen one, so the address bar is a link to what is on screen. The cookie
    // above still carries the choice into the pages without a language URL.
    const { rest } = splitLocalePrefix(window.location.pathname);
    if (isPrefixablePath(rest)) {
      window.location.assign(localizePath(rest, locale) + window.location.search + window.location.hash);
      return;
    }
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-1 text-xs" aria-label={SWITCHER_LABEL[current]} data-testid="language-switcher">
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
