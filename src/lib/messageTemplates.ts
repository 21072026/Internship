import { locales, defaultLocale, isLocale, type Locale } from '@/i18n/config';

// Canned responses (#1871) — the resolution rules for the trilingual message
// template pool, in one client-safe module so the admin screen, the composer
// picker and the API routes all agree on them.
//
// The shape is `ProjectTaskTemplate`'s (src/lib/goalTemplates.ts): `title` is the
// canonical wording — the dedupe key and the fallback for a reader whose
// language has no entry — and `translations` holds the per-locale body. The one
// difference that earns a separate module is the size: a goal is a line, a
// canned reply is a paragraph, so the bound here is MAX_TEMPLATE_BODY rather
// than goalTemplates' 300 characters.
//
// The other difference is *whose* language wins. A goal template is resolved
// into the **assignee's** language, because they are the one who will read it. A
// canned response is resolved into the **writer's** language: they are about to
// send it under their own name and have to be able to read what they are
// sending. Answering "which language" wrongly here is the difference between a
// convenience and a mentor unknowingly sending German to a Turkish mentee.

export type MessageTemplateTranslations = Partial<Record<Locale, string>>;

/** Longest canned reply we store, per language. A paragraph or two. */
export const MAX_TEMPLATE_BODY = 2_000;

/** Keep only known locales with non-empty text, trimmed and length-bounded. */
export function normalizeMessageTranslations(input: unknown): MessageTemplateTranslations {
  if (!input || typeof input !== 'object') return {};
  const raw = input as Record<string, unknown>;
  const out: MessageTemplateTranslations = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isLocale(key) || typeof value !== 'string') continue;
    const text = value.trim().slice(0, MAX_TEMPLATE_BODY);
    if (text) out[key] = text;
  }
  return out;
}

/** Read a stored `translations` column back. */
export function readMessageTranslations(value: unknown): MessageTemplateTranslations {
  return normalizeMessageTranslations(value);
}

/**
 * The wording to store in `title`: the default locale's text when there is one,
 * otherwise the first language that was filled in. Returns '' when nothing was.
 */
export function canonicalMessageText(
  translations: MessageTemplateTranslations,
  fallback?: string
): string {
  const preferred = translations[defaultLocale];
  if (preferred) return preferred;
  for (const locale of locales) {
    const text = translations[locale];
    if (text) return text;
  }
  return (fallback ?? '').trim().slice(0, MAX_TEMPLATE_BODY);
}

/**
 * The text one writer gets when they pick this template. Their own language
 * wins; then the default locale (a reply written only in English is still worth
 * offering to a Turkish mentor, who can edit it, rather than showing nothing);
 * then `title`.
 */
export function resolveMessageTemplateText(
  template: { title: string; translations?: unknown },
  language: string | null | undefined
): string {
  const translations = readMessageTranslations(template.translations);
  if (isLocale(language) && translations[language]) return translations[language] as string;
  return translations[defaultLocale] ?? template.title;
}

/** The client-facing shape of a template. `personal` = mine, not org-wide. */
export interface MessageTemplateDto {
  id: string;
  title: string;
  translations: MessageTemplateTranslations;
  useCount: number;
  personal: boolean;
}

/** DB row → DTO. One place, so every route serializes a template identically. */
export function serializeMessageTemplate(row: {
  id: string;
  title: string;
  translations: unknown;
  useCount: number;
  ownerId: string | null;
}): MessageTemplateDto {
  return {
    id: row.id,
    title: row.title,
    translations: readMessageTranslations(row.translations),
    useCount: row.useCount,
    personal: row.ownerId !== null,
  };
}

/** A one-line preview for the picker — the pool is browsed, not read. */
export function templatePreview(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
