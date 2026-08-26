import { locales, defaultLocale, isLocale, type Locale } from '@/i18n/config';
import { TEXT_LIMITS } from '@/lib/textLimits';

/**
 * The newsletter's shape, its per-language resolution and its one-click
 * unsubscribe token (#1469).
 *
 * WHY AN ISSUE IS A FIXED SHAPE, NOT FREE TEXT
 *
 * An announcement is a textarea because operational messages have no format.
 * A newsletter that is a textarea becomes a wall of text within three issues,
 * and a wall of text is the thing people unsubscribe from — the format IS the
 * product here. So an issue is: one subject, one preheader, two sentences of
 * intro, three-to-five emoji-headed tips, one ten-minute action, one optional
 * button. Every field is capped in `textLimits.ts` at a length that stays
 * readable on a phone. An admin can write whatever they like inside those
 * boxes; they cannot turn the thing into an essay.
 *
 * Node-free on purpose: the admin composer is a client component and imports
 * the types, the caps and `NEWSLETTER_MAX_TIPS` from here. The signing and the
 * URL builders live in `newsletterTokens.ts`, which is server-only — pulling
 * `crypto` into a page bundle to get a type would be the wrong trade.
 *
 * Same per-locale pattern as `announcementText.ts` and `localizedEmail.ts`: a
 * canonical version plus a per-locale map, resolved once per recipient. The
 * unit here is the whole issue — a Turkish body under an English subject, or a
 * German intro over English tips, is worse than either language alone.
 */

export interface NewsletterTip {
  /** One emoji, shown in the tip's bullet. Not decoration — it is the scan handle. */
  emoji: string;
  title: string;
  body: string;
}

export interface NewsletterCta {
  label: string;
  /** http(s) only — checked by `safeCtaUrl` below before it reaches a mail body. */
  url: string;
}

export interface NewsletterIssueContent {
  subject: string;
  /** The line mail clients show next to the subject. Blank wastes prime space. */
  preheader?: string;
  intro: string;
  tips: NewsletterTip[];
  /** "Do this one thing in ten minutes" — the issue's single call to action. */
  action?: string;
  cta?: NewsletterCta;
  /**
   * Shown ONLY to mentors, and only on a MENTOR/BOTH issue. This is what lets
   * one issue serve both audiences: the mentee reads "here is how to write a
   * CV bullet", the mentor reads the same issue plus "ask your mentee to
   * rewrite two bullets before your next call".
   */
  mentorNote?: string;
}

export type NewsletterVariants = Partial<Record<Locale, NewsletterIssueContent>>;

export type NewsletterAudience = 'MENTEE' | 'MENTOR' | 'BOTH';
export type NewsletterStatus = 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELED';

/** How many tips one issue may carry. Beyond this it stops being skimmable. */
export const NEWSLETTER_MAX_TIPS = 5;
export const NEWSLETTER_MIN_TIPS = 1;

/** The e-mail category — its own bucket in EmailLog and in the bulk transport. */
export const NEWSLETTER_EMAIL_CATEGORY = 'newsletter';

/** Which roles an audience resolves to. */
export function audienceRoles(audience: NewsletterAudience): ('MENTEE' | 'MENTOR')[] {
  if (audience === 'MENTEE') return ['MENTEE'];
  if (audience === 'MENTOR') return ['MENTOR'];
  return ['MENTEE', 'MENTOR'];
}

/**
 * An ADMIN who also mentors reads mentor mail (the product's dual-role case),
 * but nobody should receive a mentee issue because they happen to be an admin.
 * Admins are therefore included in MENTOR and BOTH audiences only — and that is
 * also what makes "send me a test" work without a second code path.
 */
export function audienceIncludesRole(audience: NewsletterAudience, role: string): boolean {
  if (role === 'MENTEE') return audience === 'MENTEE' || audience === 'BOTH';
  if (role === 'MENTOR' || role === 'ADMIN') return audience === 'MENTOR' || audience === 'BOTH';
  return false;
}

/** Does this recipient get the mentor-only block? */
export function showsMentorNote(audience: NewsletterAudience, role: string): boolean {
  return (role === 'MENTOR' || role === 'ADMIN') && (audience === 'MENTOR' || audience === 'BOTH');
}

const trim = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * `null` unless the URL is a syntactically valid http(s) one.
 *
 * The CTA lands in an `href` inside an e-mail body, so a `javascript:` or
 * `data:` URL here would be a stored-XSS delivery mechanism with our From
 * header on it. Rejected rather than escaped: there is no legitimate newsletter
 * button that needs another scheme.
 */
export function safeCtaUrl(value: unknown): string | null {
  const raw = trim(value, TEXT_LIMITS.newsletterCtaUrl);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** One emoji-ish grapheme, or a safe default. Never markup. */
function normalizeEmoji(value: unknown): string {
  const raw = trim(value, 8).replace(/[<>&"']/g, '');
  return [...raw][0] ?? '💡';
}

function normalizeTips(input: unknown): NewsletterTip[] {
  if (!Array.isArray(input)) return [];
  const tips: NewsletterTip[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const title = trim(t.title, TEXT_LIMITS.newsletterTipTitle);
    const body = trim(t.body, TEXT_LIMITS.newsletterTipBody);
    // A tip needs a heading; the body may be empty for a one-liner tip whose
    // heading says it all. A tip with neither is nothing at all.
    if (!title) continue;
    tips.push({ emoji: normalizeEmoji(t.emoji), title, body });
    if (tips.length >= NEWSLETTER_MAX_TIPS) break;
  }
  return tips;
}

/**
 * One language's issue, or `null` when it is too incomplete to send.
 *
 * "Complete" is subject + intro + at least one tip. A half-written language is
 * dropped rather than sent — the fallback to another language is a better
 * outcome for the reader than an e-mail with an empty body, the same call
 * `normalizeEmailVariants` makes for the bulk composer.
 */
export function normalizeIssueContent(input: unknown): NewsletterIssueContent | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  const subject = trim(c.subject, TEXT_LIMITS.newsletterSubject);
  const intro = trim(c.intro, TEXT_LIMITS.newsletterIntro);
  const tips = normalizeTips(c.tips);
  if (!subject || !intro || tips.length < NEWSLETTER_MIN_TIPS) return null;

  const ctaUrl = safeCtaUrl((c.cta as Record<string, unknown> | undefined)?.url);
  const ctaLabel = trim((c.cta as Record<string, unknown> | undefined)?.label, TEXT_LIMITS.newsletterCtaLabel);

  return {
    subject,
    ...(trim(c.preheader, TEXT_LIMITS.newsletterPreheader) ? { preheader: trim(c.preheader, TEXT_LIMITS.newsletterPreheader) } : {}),
    intro,
    tips,
    ...(trim(c.action, TEXT_LIMITS.newsletterAction) ? { action: trim(c.action, TEXT_LIMITS.newsletterAction) } : {}),
    // Both halves or neither: a button with no target is a dead end, and a
    // target with no label renders as a bare URL.
    ...(ctaUrl && ctaLabel ? { cta: { label: ctaLabel, url: ctaUrl } } : {}),
    ...(trim(c.mentorNote, TEXT_LIMITS.newsletterMentorNote) ? { mentorNote: trim(c.mentorNote, TEXT_LIMITS.newsletterMentorNote) } : {}),
  };
}

/** Keep only known locales whose issue is complete. */
export function normalizeNewsletterContent(input: unknown): NewsletterVariants {
  if (!input || typeof input !== 'object') return {};
  const out: NewsletterVariants = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isLocale(key)) continue;
    const content = normalizeIssueContent(value);
    if (content) out[key] = content;
  }
  return out;
}

/**
 * The version to treat as canonical: the default locale's, else the first
 * language that was written. `null` when the issue has no complete language at
 * all — which is what makes "you have not written anything sendable yet" a
 * validation error rather than an empty e-mail.
 */
export function canonicalNewsletterContent(variants: NewsletterVariants): NewsletterIssueContent | null {
  const preferred = variants[defaultLocale];
  if (preferred) return preferred;
  for (const locale of locales) {
    const found = variants[locale];
    if (found) return found;
  }
  return null;
}

/** What one recipient is served: their language, then the canonical version. */
export function resolveNewsletterContent(
  variants: NewsletterVariants,
  canonical: NewsletterIssueContent,
  language: string | null | undefined
): NewsletterIssueContent {
  if (isLocale(language) && variants[language]) return variants[language] as NewsletterIssueContent;
  return variants[defaultLocale] ?? canonical;
}

/** Which language a recipient will actually be served — recorded per send. */
export function resolveNewsletterLocale(variants: NewsletterVariants, language: string | null | undefined): Locale {
  if (isLocale(language) && variants[language]) return language;
  if (variants[defaultLocale]) return defaultLocale;
  return locales.find((l) => variants[l]) ?? defaultLocale;
}

/** The languages this issue was actually written in, in a stable order. */
export function writtenNewsletterLocales(variants: NewsletterVariants): Locale[] {
  return locales.filter((locale) => !!variants[locale]);
}

/** True when this reader is being served a language the issue was not written in. */
export function isNewsletterFallback(variants: NewsletterVariants, language: string | null | undefined): boolean {
  if (!isLocale(language)) return false;
  const written = writtenNewsletterLocales(variants);
  return written.length > 0 && !written.includes(language);
}

/** Where an issue's hero image is served from. */
export function newsletterImageUrl(newsletterId: string): string {
  return `/api/newsletters/${newsletterId}/image`;
}

/**
 * The `notificationPrefs` object with only the newsletter switch changed.
 *
 * Merged, never replaced: that JSON column holds every other category switch
 * too, and writing `{ newsletter: false }` over it would silently re-enable
 * everything the person had turned off. Shared by the token route (unsubscribe
 * from the e-mail) and the session route (re-subscribe from the archive) so the
 * two cannot drift.
 */
export function withNewsletterPref(prefs: unknown, subscribed: boolean): Record<string, unknown> {
  const base =
    prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : {};
  return { ...base, newsletter: subscribed };
}
