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

// A to-do as the UI needs it: `title` is the wording for a hand-written one, and
// `template` is present when the to-do came from the shared pool — in which case
// the text is read from the template every time, so rewording it in one place
// reaches everyone who was given it, in each of their own languages (#1113).
export interface TaskTitleSource {
  title: string;
  template?: { title: string; translations?: unknown } | null;
}

/** The wording a to-do shows to one reader — dynamic when it is a shared one. */
export function resolveTaskTitle(task: TaskTitleSource, language: string | null | undefined): string {
  return task.template ? resolveTemplateTitle(task.template, language) : task.title;
}

// What a to-do's shared half needs from the DB. Used by every endpoint that
// returns to-dos so the client can resolve the wording in the reader's language.
export const taskTemplateSelect = {
  select: { id: true, title: true, translations: true, archivedAt: true },
} as const;

/** The client-facing shape of a to-do's template half (null when hand-written). */
export function serializeTaskTemplate(
  template: { id: string; title: string; translations: unknown; archivedAt: Date | null } | null | undefined
) {
  if (!template) return null;
  return {
    id: template.id,
    title: template.title,
    translations: readTranslations(template.translations),
    // Retired from the pool but still assigned — the wording keeps working.
    archived: template.archivedAt !== null,
  };
}
