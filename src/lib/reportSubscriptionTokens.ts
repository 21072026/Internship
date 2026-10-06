import { createHmac } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';
import { safeEqual } from '@/lib/secretBox';

/**
 * Server-only half of report subscriptions (#1905): the signed unsubscribe
 * token and the link that carries it. Split from src/lib/reportSubscriptions.ts
 * for the reason the newsletter split is (docs/newsletter.md): the rules module
 * is imported by client components, and `crypto` plus the server secret have
 * no business in a page bundle.
 *
 * The recipient may have no account at all — a dean, a funder — so the token
 * IS the authorisation, exactly like the newsletter's: it names one
 * subscription and honouring it can do exactly one thing, switch that
 * subscription off. No expiry: a report read in six months must still have a
 * working way out.
 */

function sign(subscriptionId: string): string {
  return createHmac('sha256', requireServerSecret()).update(`report-sub-unsub:${subscriptionId}`).digest('hex').slice(0, 32);
}

export function makeReportUnsubscribeToken(subscriptionId: string): string {
  return `${subscriptionId}.${sign(subscriptionId)}`;
}

export function verifyReportUnsubscribeToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(id))) return null;
  return id;
}

/**
 * The link in the mail. A PAGE, not the API: link scanners prefetch every URL
 * in a message, and a mutating GET would unsubscribe people who never clicked.
 * The page POSTs.
 */
export function reportUnsubscribeUrl(subscriptionId: string, origin?: string | null): string {
  const base = origin || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return `${base}/reports/unsubscribe?token=${encodeURIComponent(makeReportUnsubscribeToken(subscriptionId))}`;
}
