import { locales, defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { TEXT_LIMITS } from '@/lib/textLimits';

// One outgoing email written in more than one language (#1165).
//
// The mentor/admin bulk composer sends a single subject+body to a group of
// mentees who do not all read the same language — the ready-made templates
// already exist in EN/TR/DE (`emailTemplates` in the dictionaries), but only
// the *sender's* locale was ever used, so the whole group got whichever
// language the sender's UI happened to be in.
//
// Same shape as src/lib/announcementText.ts and src/lib/goalTemplates.ts: a
// canonical value plus a per-locale map, resolved once per recipient. The only
// difference here is that the unit is a pair (subject and body travel together —
// a Turkish body under an English subject is worse than either alone).

export interface EmailContent {
  subject: string;
  body: string;
}

export type EmailVariants = Partial<Record<Locale, EmailContent>>;

/** Keep only known locales whose subject AND body are both non-empty. */
export function normalizeEmailVariants(input: unknown): EmailVariants {
  if (!input || typeof input !== 'object') return {};
  const out: EmailVariants = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isLocale(key) || !value || typeof value !== 'object') continue;
    const { subject, body } = value as Record<string, unknown>;
    if (typeof subject !== 'string' || typeof body !== 'string') continue;
    const trimmedSubject = subject.trim().slice(0, TEXT_LIMITS.mentorEmailSubject);
    const trimmedBody = body.trim().slice(0, TEXT_LIMITS.mentorEmailBody);
    // A half-written language is dropped rather than sent: an empty subject or
    // an empty body would go out as a broken email, and the fallback below is a
    // better outcome than that.
    if (!trimmedSubject || !trimmedBody) continue;
    out[key] = { subject: trimmedSubject, body: trimmedBody };
  }
  return out;
}

/**
 * The version to treat as canonical — the default locale's, else the first
 * language filled in, else the plain subject/body a single-language client sent.
 * Returns null when there is no complete message at all.
 */
export function canonicalEmail(variants: EmailVariants, fallback?: Partial<EmailContent>): EmailContent | null {
  const preferred = variants[defaultLocale];
  if (preferred) return preferred;
  for (const locale of locales) {
    const found = variants[locale];
    if (found) return found;
  }
  const subject = fallback?.subject?.trim();
  const body = fallback?.body?.trim();
  return subject && body ? { subject, body } : null;
}

/** What one recipient is sent: their language, then the canonical version. */
export function resolveEmail(
  variants: EmailVariants,
  canonical: EmailContent,
  language: string | null | undefined
): EmailContent {
  if (isLocale(language) && variants[language]) return variants[language] as EmailContent;
  return variants[defaultLocale] ?? canonical;
}

/** The languages this message was actually written in, in a stable order. */
export function writtenEmailLocales(variants: EmailVariants): Locale[] {
  return locales.filter((locale) => !!variants[locale]);
}
