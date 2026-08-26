import { createHmac } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';
import { safeEqual } from '@/lib/secretBox';

/**
 * Server-only half of the newsletter module (#1469): the one-click unsubscribe
 * token and the absolute URLs that go into a mail body.
 *
 * Split out of `newsletter.ts` because that file is imported by the admin
 * composer, which is a client component — `crypto` and the server secret have
 * no business in a page bundle.
 */

// ── One-click unsubscribe ───────────────────────────────────────────────────
//
// Leaving has to work from the e-mail itself, with no login and no "manage
// your preferences" maze. Anything harder and the reader reaches for the spam
// button instead — which costs the *whole* sending domain, including the
// password-reset mail. A frictionless unsubscribe is deliverability
// protection, not a courtesy.
//
// Same HMAC construction (and the same trust argument) as
// `lib/reEngagement.ts`'s leave token and `lib/consentRenew.ts`: the link is
// only ever delivered to that user's registered address, and honouring it can
// do exactly one thing — stop newsletters. No expiry, deliberately: an issue
// read eight months later must still have a working unsubscribe.

function signUnsubscribe(userId: string): string {
  return createHmac('sha256', requireServerSecret()).update(`newsletter-unsub:${userId}`).digest('hex').slice(0, 32);
}

export function makeUnsubscribeToken(userId: string): string {
  return `${userId}.${signUnsubscribe(userId)}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), signUnsubscribe(userId))) return null;
  return userId;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/**
 * The unsubscribe link in the footer. Points at a *page* rather than an API
 * route for the same reason as `emailActionUrl`: link scanners (Outlook Safe
 * Links, antivirus gateways) prefetch every URL in a message, and a mutating
 * GET would unsubscribe people who never clicked. The page POSTs.
 */
export function newsletterUnsubscribeUrl(userId: string): string {
  return `${appUrl()}/newsletter/unsubscribe?token=${encodeURIComponent(makeUnsubscribeToken(userId))}`;
}

/** The signed-in archive of past issues, linked from every footer. */
export function newsletterArchiveUrl(): string {
  return `${appUrl()}/newsletters`;
}

/** Where the footer's "which e-mails do I get" link goes. */
export function newsletterPreferencesUrl(): string {
  return `${appUrl()}/account`;
}
