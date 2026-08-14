import { locales, defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { TEXT_LIMITS } from '@/lib/textLimits';

// Multilingual announcements (#1163).
//
// An announcement is one message written in up to three languages. `text` stays
// the canonical wording — it is what every row written before this existed
// carries, and the fallback for a reader whose language has no entry — and
// `translations` holds the per-locale bodies. Everything downstream (the card,
// the archive, the bell, the email) receives a plain resolved string, so nothing
// past this module has to know a message has more than one version.
//
// Deliberately the same shape as src/lib/goalTemplates.ts, which solved this
// problem first for goal templates: one canonical column plus a nullable JSON
// map, resolved per reader. Keeping the two identical means one mental model,
// not two.

export type AnnouncementTranslations = Partial<Record<Locale, string>>;

/** Keep only known locales with non-empty text, trimmed and length-bounded. */
export function normalizeAnnouncementTranslations(input: unknown): AnnouncementTranslations {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const out: AnnouncementTranslations = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isLocale(key) || typeof value !== 'string') continue;
    const text = value.trim().slice(0, TEXT_LIMITS.announcementText);
    if (text) out[key] = text;
  }
  return out;
}

/**
 * The wording to store in `text`: the default locale's version when there is
 * one, otherwise the first language that was filled in. Returns '' when nothing
 * was — callers treat that as a validation failure.
 */
export function canonicalAnnouncementText(
  translations: AnnouncementTranslations,
  fallback?: string
): string {
  const preferred = translations[defaultLocale];
  if (preferred) return preferred;
  for (const locale of locales) {
    const text = translations[locale];
    if (text) return text;
  }
  return (fallback ?? '').trim().slice(0, TEXT_LIMITS.announcementText);
}

/**
 * What one person reads. Their own language wins; then the default locale (an
 * announcement written only in English still reads for a Turkish mentee rather
 * than showing nothing); then the canonical `text`.
 */
export function resolveAnnouncementText(
  announcement: { text: string; translations?: unknown },
  language: string | null | undefined
): string {
  const translations = normalizeAnnouncementTranslations(announcement.translations);
  if (isLocale(language) && translations[language]) return translations[language] as string;
  return translations[defaultLocale] ?? announcement.text;
}

/**
 * True when the reader is NOT getting their own language — the announcement was
 * never written in it, so what they see is a fallback. The UI says so rather
 * than silently presenting a foreign-language message as if it were meant for
 * them.
 */
export function isAnnouncementFallback(
  announcement: { translations?: unknown },
  language: string | null | undefined
): boolean {
  const translations = normalizeAnnouncementTranslations(announcement.translations);
  // Nothing was ever translated: this is a plain single-language announcement,
  // which is not a "fallback" in any sense the reader needs to be warned about.
  if (Object.keys(translations).length === 0) return false;
  const reader = isLocale(language) ? language : defaultLocale;
  return !translations[reader];
}

/** The languages an announcement was actually written in, in a stable order. */
export function writtenLocales(translations: AnnouncementTranslations): Locale[] {
  return locales.filter((locale) => !!translations[locale]);
}
