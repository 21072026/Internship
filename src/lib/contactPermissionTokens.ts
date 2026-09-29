import { createHmac } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';
import { safeEqual } from '@/lib/secretBox';

/**
 * The two signed links of the double opt-in (#2577): "yes, send me product
 * news" and "no — and do not write to me".
 *
 * Same HMAC construction and trust argument as `newsletterTokens.ts`: the link
 * is only ever delivered to the address on the request, so holding it is the
 * proof that you read that inbox. Each token names ONE enquiry and has its own
 * purpose prefix, so a confirm token cannot be replayed as an opt-out (or the
 * reverse), and no other token in the app verifies as either. There is no
 * expiry in the token: the confirm window (DOI_CONFIRM_WINDOW_DAYS) is decided
 * from the enquiry's own `createdAt` on the server, and an opt-out never
 * expires — somebody who wants out months later must still get out.
 *
 * Both links point at a PAGE that performs a POST (see /contact-permission):
 * mail scanners prefetch every URL in a message, and a mutating GET would
 * confirm consents nobody gave.
 */

type Purpose = 'confirm' | 'optout';

function sign(purpose: Purpose, inquiryId: string): string {
  return createHmac('sha256', requireServerSecret())
    .update(`contact-permission-${purpose}:${inquiryId}`)
    .digest('hex')
    .slice(0, 32);
}

export function makeContactPermissionToken(purpose: Purpose, inquiryId: string): string {
  return `${inquiryId}.${sign(purpose, inquiryId)}`;
}

export function verifyContactPermissionToken(purpose: Purpose, token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const inquiryId = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(purpose, inquiryId))) return null;
  return inquiryId;
}

/**
 * The absolute link for the mail. `origin` is the origin the request arrived on
 * (`requestOrigin()` — only a host this deployment serves), so a marketing
 * visitor's confirmation page is on the marketing host, in its branding.
 */
export function contactPermissionUrl(origin: string, purpose: Purpose, inquiryId: string): string {
  const path = purpose === 'confirm' ? '/contact-permission/confirm' : '/contact-permission/opt-out';
  return `${origin}${path}?token=${encodeURIComponent(makeContactPermissionToken(purpose, inquiryId))}`;
}
