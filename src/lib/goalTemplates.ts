import { locales, defaultLocale, isLocale, type Locale } from '@/i18n/config';

// Multilingual goal templates (#51 follow-up).
//
// A template is one goal written in up to three languages. `title` stays the
// canonical wording — it is the pool's dedupe key and the fallback when the
// reader's language has no entry — and `translations` carries the per-locale
// text. A ProjectTask created from a template is a plain string, resolved once
// from the assignee's own language, so nothing downstream has to know about any
// of this.

export type TemplateTranslations = Partial<Record<Locale, string>>;

const MAX_TITLE = 300;

/** Keep only known locales with non-empty text, trimmed and length-bounded. */
export function normalizeTranslations(input: unknown): TemplateTranslations {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const out: TemplateTranslations = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isLocale(key) || typeof value !== 'string') continue;
    const text = value.trim().slice(0, MAX_TITLE);
    if (text) out[key] = text;
  }
  return out;
}

/** Read a stored `translations` column back. */
export function readTranslations(value: unknown): TemplateTranslations {
  return normalizeTranslations(value);
}

/**
 * The wording to store in `title`: the default locale's text when there is one,
 * otherwise the first language that was filled in. Returns '' when nothing was.
 */
export function canonicalTitle(translations: TemplateTranslations, fallback?: string): string {
  const preferred = translations[defaultLocale];
  if (preferred) return preferred;
  for (const locale of locales) {
    const text = translations[locale];
    if (text) return text;
  }
  return (fallback ?? '').trim().slice(0, MAX_TITLE);
}

/**
 * The wording one person sees. Their own language wins; then the default locale
 * (a template written only in English still reads for a Turkish mentee, rather
 * than showing nothing); then `title`.
 */
export function resolveTemplateTitle(
  template: { title: string; translations?: unknown },
  language: string | null | undefined
): string {
  const translations = readTranslations(template.translations);
  if (isLocale(language) && translations[language]) return translations[language] as string;
  return translations[defaultLocale] ?? template.title;
}
