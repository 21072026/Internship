'use client';

import { defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { useT } from '@/i18n/client';

// Which language a person reads, shown next to their name wherever you are
// about to write TO them (#1164).
//
// Every user has a `preferredLanguage` and the app speaks EN/TR/DE, but that
// preference was invisible on exactly the screens where it matters — the bulk
// email composer, a chat header — so people were being written to in a language
// they had not chosen. An unmarked name gives the sender no clue; a two-letter
// chip does, without taking a line of its own.
//
// A user who never picked one is shown the app default in a muted style: the
// distinction between "chose English" and "never chose" is the difference
// between a safe assumption and a guess, so it stays visible.
export function LanguageBadge({
  language,
  className = '',
}: {
  language?: string | null;
  className?: string;
}) {
  const t = useT();
  const chosen = isLocale(language);
  const locale: Locale = chosen ? language : defaultLocale;
  const name = t.account.languages[locale];
  const title = (chosen ? t.languageBadge.prefers : t.languageBadge.unset).replace('{lang}', name);

  return (
    <span
      data-testid={`language-badge-${locale}`}
      data-language-set={chosen ? 'true' : 'false'}
      title={title}
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        chosen
          ? 'bg-blue-50 text-blue-700 dark:!bg-blue-900/40 dark:!text-blue-200'
          : 'bg-gray-100 text-gray-400 dark:!bg-gray-800 dark:!text-gray-500'
      } ${className}`}
    >
      {locale}
    </span>
  );
}

/**
 * Count how many people in a group read each language, most-common first, so a
 * bulk send can say "you are writing one text to 2 TR and 1 DE" before it goes
 * out. Unset preferences fold into the app default — that is what those people
 * will actually receive.
 */
export function languageBreakdown(languages: (string | null | undefined)[]): { locale: Locale; count: number }[] {
  const counts = new Map<Locale, number>();
  for (const raw of languages) {
    const locale: Locale = isLocale(raw) ? raw : defaultLocale;
    counts.set(locale, (counts.get(locale) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([locale, count]) => ({ locale, count }))
    .sort((a, b) => b.count - a.count || a.locale.localeCompare(b.locale));
}
