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

// ── Channels (#3908) ─────────────────────────────────────────────────────────
// One pool, two uses: `message` — a canned reply for the in-app composer (every
// row before #3908, the column's default) — and `email` — a mail a sales rep
// opens in their OWN mail program from a lead (`mailto:`; the CRM sends
// nothing to a lead, #3741). An e-mail template also has a subject per locale.

export const MESSAGE_TEMPLATE_CHANNELS = ['message', 'email'] as const;
export type MessageTemplateChannel = (typeof MESSAGE_TEMPLATE_CHANNELS)[number];

export function isTemplateChannel(value: unknown): value is MessageTemplateChannel {
  return typeof value === 'string' && (MESSAGE_TEMPLATE_CHANNELS as readonly string[]).includes(value);
}

/** The channel a request asked for; anything else is the composer's `message`. */
export function templateChannel(value: unknown): MessageTemplateChannel {
  return isTemplateChannel(value) ? value : 'message';
}

/** Longest subject we store, per language — a mail subject line. */
export const MAX_TEMPLATE_SUBJECT = 200;

/** Keep only known locales with non-empty, single-line, length-bounded subjects. */
export function normalizeTemplateSubjects(input: unknown): MessageTemplateTranslations {
  if (!input || typeof input !== 'object') return {};
  const out: MessageTemplateTranslations = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isLocale(key) || typeof value !== 'string') continue;
    const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEMPLATE_SUBJECT);
    if (text) out[key] = text;
  }
  return out;
}

/** The placeholders an e-mail template may carry, filled from the lead's record. */
export const EMAIL_TEMPLATE_PLACEHOLDERS = ['name', 'company', 'sender'] as const;
export type EmailTemplateVars = Partial<Record<(typeof EMAIL_TEMPLATE_PLACEHOLDERS)[number], string | null>>;

/**
 * `{name}`, `{company}`, `{sender}` → the lead's contact, its account, the rep.
 * A value we do not have becomes '' (never the raw `{name}` in a customer's
 * inbox); any other brace text is left as written.
 */
export function fillEmailPlaceholders(text: string, vars: EmailTemplateVars): string {
  return text.replace(/\{(name|company|sender)\}/g, (_, key: keyof EmailTemplateVars) => (vars[key] ?? '').trim());
}

/**
 * The `mailto:` a picked e-mail template opens: subject and body in the
 * writer's language (the same rule as a canned reply — they send it under their
 * own name), placeholders filled. RFC 6068: every part percent-encoded, line
 * breaks as CRLF.
 */
export function emailTemplateMailto(
  to: string,
  template: { title: string; translations?: unknown; subjects?: unknown },
  language: string | null | undefined,
  vars: EmailTemplateVars,
): string {
  const subjects = normalizeTemplateSubjects(template.subjects);
  const subject = fillEmailPlaceholders(
    (isLocale(language) && subjects[language]) || subjects[defaultLocale] || Object.values(subjects)[0] || '',
    vars,
  );
  const body = fillEmailPlaceholders(resolveMessageTemplateText(template, language), vars).replace(/\r?\n/g, '\r\n');
  const params = [subject && `subject=${encodeURIComponent(subject)}`, body && `body=${encodeURIComponent(body)}`].filter(Boolean);
  return `mailto:${encodeURIComponent(to.trim()).replace(/%40/g, '@')}${params.length ? `?${params.join('&')}` : ''}`;
}

/** The client-facing shape of a template. `personal` = mine, not org-wide. */
export interface MessageTemplateDto {
  id: string;
  title: string;
  translations: MessageTemplateTranslations;
  channel: MessageTemplateChannel;
  /** An e-mail template's subject per locale; {} on a canned reply. */
  subjects: MessageTemplateTranslations;
  useCount: number;
  personal: boolean;
  /** Only on the admin screen (#2055): locales a machine filled and nobody reviewed yet. */
  machineTranslated?: Locale[];
}

/** DB row → DTO. One place, so every route serializes a template identically. */
export function serializeMessageTemplate(row: {
  id: string;
  title: string;
  translations: unknown;
  useCount: number;
  ownerId: string | null;
  channel?: string | null;
  subjects?: unknown;
}): MessageTemplateDto {
  return {
    id: row.id,
    title: row.title,
    translations: readMessageTranslations(row.translations),
    channel: templateChannel(row.channel),
    subjects: normalizeTemplateSubjects(row.subjects),
    useCount: row.useCount,
    personal: row.ownerId !== null,
  };
}

/** A one-line preview for the picker — the pool is browsed, not read. */
export function templatePreview(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
