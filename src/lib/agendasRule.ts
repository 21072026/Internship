import { locales, defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { TEXT_LIMITS } from '@/lib/textLimits';

// The dependency-free half of src/lib/agendas.ts (#1841): everything that
// resolves wording, with no Prisma import, so the unit test can load it under
// `node --test --experimental-strip-types` and so a client component can import
// it without dragging the Prisma client into a page bundle.
//
// `normalizeTranslations` / `canonicalTitle` / `resolveTemplateTitle` in
// src/lib/goalTemplates.ts are the originals; these are their agenda twins,
// kept separate rather than generic so that each module reads in its own
// vocabulary and neither changes when the other's bound does.

export type AgendaTranslations = Partial<Record<Locale, string>>;

// AgendaTemplate.title and AgendaTemplateItem.prompt are VARCHAR(191) — the same
// width as a to-do title, so the same bound (#1433: a longer slice passes
// validation and dies in the INSERT as a P2000).
const MAX_TEXT = TEXT_LIMITS.todoTitle;

/** Keep only known locales with non-empty text, trimmed and length-bounded. */
export function normalizeAgendaTranslations(input: unknown, max: number = MAX_TEXT): AgendaTranslations {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const out: AgendaTranslations = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isLocale(key) || typeof value !== 'string') continue;
    const text = value.trim().slice(0, max);
    if (text) out[key] = text;
  }
  return out;
}

/** Read a stored `translations` / `summary` column back. */
export function readAgendaTranslations(value: unknown): AgendaTranslations {
  return normalizeAgendaTranslations(value, Number.MAX_SAFE_INTEGER);
}

/**
 * The wording to store in the canonical column: the default locale's text when
 * there is one, otherwise the first language that was filled in. '' when none.
 */
export function canonicalPrompt(translations: AgendaTranslations, fallback?: string): string {
  const preferred = translations[defaultLocale];
  if (preferred) return preferred;
  for (const locale of locales) {
    const text = translations[locale];
    if (text) return text;
  }
  return (fallback ?? '').trim().slice(0, MAX_TEXT);
}

/**
 * The wording one person sees of a template-side string (a title, a prompt, a
 * summary). Their own language wins; then the default locale (a conversation
 * written only in English still reads for a Turkish mentee rather than showing
 * nothing); then the canonical `text`.
 */
export function resolveTemplateText(
  source: { text: string; translations?: unknown },
  language: string | null | undefined
): string {
  const translations = readAgendaTranslations(source.translations);
  if (isLocale(language) && translations[language]) return translations[language] as string;
  return translations[defaultLocale] ?? source.text;
}

// A session item as the UI needs it: `text` is the wording of an ad-hoc line,
// and `templateItem` is present when the line came from the library — in which
// case the wording is read from the template on every render, so rewording it
// in one place reaches every session that was given it, in each reader's own
// language.
export interface AgendaItemTextSource {
  text: string;
  templateItem?: { prompt: string; translations?: unknown } | null;
}

/** The wording a session item shows to one reader — live when it is templated. */
export function resolveItemText(item: AgendaItemTextSource, language: string | null | undefined): string {
  return item.templateItem
    ? resolveTemplateText({ text: item.templateItem.prompt, translations: item.templateItem.translations }, language)
    : item.text;
}
