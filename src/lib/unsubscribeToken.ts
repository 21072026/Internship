import { createHmac, timingSafeEqual } from 'crypto';
import { requireServerSecret } from '@/lib/serverSecret';
import { isEmailGroupId, type EmailGroupId } from '@/lib/emailGroups';

// Signed unsubscribe links for the footer of every non-essential e-mail (#1444).
//
// Construction is deliberately identical to src/lib/emailActionToken.ts — `~`
// between the fields (an RFC 3986 unreserved character, so it survives a round
// trip through a URL path segment untouched, which `|` did not), `.` before the
// signature, HMAC-SHA256 over requireServerSecret() truncated to 32 hex chars,
// a length check before timingSafeEqual. One shape to review, one shape to get
// wrong. The leading `u` field namespaces the payload so it can never be
// confused with an emailActionToken `k~`/`r~` payload, and the `unsubscribe:`
// prefix inside the HMAC input namespaces the *secret* usage the way
// consentRenew.ts and reEngagement.ts already do: a token minted to stop the
// digest cannot be replayed as a mark-as-read or a consent renewal.
//
// THERE IS DELIBERATELY NO EXPIRY. An unsubscribe link has to work when the
// mail is opened two years later, out of an archive, by someone who has finally
// had enough — an opt-out that expires is an opt-out that fails at exactly the
// moment a person is annoyed enough to use it, and "your unsubscribe link has
// expired" is the kind of sentence that ends up in a screenshot. The exposure
// is also strictly smaller than the 90-day emailActionToken we already mint:
// the only thing this token can do is change that one user's own notification
// preferences, and every change it can make is reversible from the same page.
const SEP = '~';

export type UnsubscribeScope = { userId: string; group: EmailGroupId | 'all' };

function sign(payload: string): string {
  return createHmac('sha256', requireServerSecret())
    .update(`unsubscribe:${payload}`)
    .digest('hex')
    .slice(0, 32);
}

/** `group: 'all'` mints the preference-centre link — it identifies the user
 *  without pre-selecting anything to switch off. */
export function makeUnsubscribeToken(userId: string, group: EmailGroupId | 'all'): string {
  const payload = ['u', userId, group].join(SEP);
  return `${payload}.${sign(payload)}`;
}

/** `null` for anything that does not verify or does not parse — a bad token is
 *  never distinguished from a forged one, because the difference is not the
 *  caller's business and telling them is free reconnaissance. */
export function verifyUnsubscribeToken(token: string): UnsubscribeScope | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  const parts = payload.split(SEP);
  if (parts.length !== 3) return null;
  const [kind, userId, group] = parts;
  if (kind !== 'u') return null;
  if (!userId) return null;
  if (group !== 'all' && !isEmailGroupId(group)) return null;
  return { userId, group: group as EmailGroupId | 'all' };
}

// No shared helper for this exists in the repo; emailActionToken.ts carries the
// same private copy. Kept identical on purpose so both sets of links agree about
// which host they point at.
function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/**
 * The "unsubscribe from this kind of mail" link in a footer. It resolves to a
 * *page*, not an API route: mail clients and corporate link scanners (Outlook
 * Safe Links, antivirus gateways) fetch every URL in a message on arrival, so a
 * mutating GET would unsubscribe people who never clicked. The page does the
 * work from the browser, and scanners do not run scripts.
 */
export function unsubscribeUrl(userId: string, group: EmailGroupId): string {
  return `${appUrl()}/u/${encodeURIComponent(makeUnsubscribeToken(userId, group))}`;
}

/** The "manage all e-mail preferences" link — same page, but scoped to `all`,
 *  which the page renders as the preference centre without switching anything
 *  off first. */
export function emailPreferencesUrl(userId: string): string {
  return `${appUrl()}/u/${encodeURIComponent(makeUnsubscribeToken(userId, 'all'))}`;
}

/**
 * The RFC 8058 one-click target advertised in `List-Unsubscribe`. This one IS
 * an API route and it IS allowed to mutate, because RFC 8058 requires the
 * mail client to POST it — and a link scanner does a GET, which that route
 * answers with a redirect to the page above instead of acting.
 */
export function oneClickUnsubscribeUrl(userId: string, group: EmailGroupId): string {
  return `${appUrl()}/api/unsubscribe/one-click?t=${encodeURIComponent(makeUnsubscribeToken(userId, group))}`;
}
