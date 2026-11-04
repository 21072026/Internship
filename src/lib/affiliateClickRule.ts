// The partner link's click redirect and daily counter (docs/affiliate-module.md,
// #3541) — pure, unit-tested (scripts/test/affiliate-click-rule.test.mjs).
//
// `GET /r/<code>` answers every visitor with a redirect, never an error page.
// WHERE it goes is decided here from the programme's `referralUrl` setting and
// the code's SHAPE only: a well-formed code goes to `referralLink(base, code)`,
// anything else to the bare base. Nothing else of the request reaches the
// target (no open redirect), and whether the code belongs to a partner is not
// asked, so the Location reveals nothing — the same reasoning as the
// `/partner?ref=` redirect (#3365). Whether the click is COUNTED is decided
// after the response, by the server half (src/lib/affiliateClicks.ts).
//
// What a click leaves behind: one counter row per partner and UTC day. The
// visitor key used for "unique" is an HMAC of the IP and user-agent under a
// key that changes every UTC day, held only in the rate-limit store until the
// end of that day; the raw IP and user-agent are never stored or logged.

import { createHmac } from 'node:crypto';
import { parseReferralUrl, referralLink } from './affiliateReferralRule';

/** A partner code's shape — the same as PARTNER_CODE_RE (src/lib/affiliatePartners.ts). */
export const CLICK_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/** Counted clicks per visitor (hashed IP) per hour; above it the visitor is still redirected. */
export const CLICK_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 } as const;

/**
 * User-agents that are not a person following a link: crawlers, link-preview
 * fetchers of chat apps and social networks (a shared link is fetched by them
 * the moment it is posted), command-line clients and headless browsers.
 */
const BOT_UA_RE =
  /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebookcatalog|embedly|preview|whatsapp|telegram|discord|slack|skype|vkshare|pinterest|quora link|bitly|curl\/|wget\/|python-requests|python-urllib|httpx|aiohttp|go-http-client|okhttp|java\/|libwww|axios\/|node-fetch|undici|headless|phantomjs|lighthouse|pagespeed|monitor|uptime|scan|validator/i;

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua || !ua.trim()) return true;
  return BOT_UA_RE.test(ua);
}

export interface ClickRequest {
  method: string;
  userAgent: string | null;
  /** `Sec-Purpose` / `Purpose` header: a browser prefetch is not a click. */
  purpose: string | null;
}

/** Whether a request may be counted at all (before the partner and the rate limit are asked). */
export function isCountableRequest(req: ClickRequest): boolean {
  if (req.method !== 'GET') return false;
  if (req.purpose && /prefetch|prerender/i.test(req.purpose)) return false;
  return !isBotUserAgent(req.userAgent);
}

/** Where `/r/<code>` sends the visitor: null when the programme has no (valid) referral URL. */
export function clickRedirectTarget(referralUrl: string | null | undefined, code: string): string | null {
  const parsed = parseReferralUrl(referralUrl);
  if (!parsed.ok || !parsed.url) return null;
  return CLICK_CODE_RE.test(code) ? referralLink(parsed.url, code) : parsed.url;
}

/** The UTC calendar day of `now`, as stored in `AffiliateClickDaily.day` (midnight UTC). */
export function clickDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Milliseconds from `now` to the next UTC midnight (≥ 1): how long a visitor key is kept. */
export function msUntilNextUtcDay(now: Date): number {
  return Math.max(1, clickDay(now).getTime() + 86_400_000 - now.getTime());
}

/**
 * The day's key: derived from a server secret and the UTC day, so every replica
 * computes the same visitor key (a shared rate-limit store dedupes across them)
 * and yesterday's keys cannot be linked to today's.
 */
function dailyKey(secret: string, now: Date): Buffer {
  return createHmac('sha256', secret).update(`affiliate-click:${clickDay(now).toISOString().slice(0, 10)}`).digest();
}

/** The visitor key for "unique" clicks: HMAC(day key, IP + user-agent). */
export function visitorKey(secret: string, now: Date, ip: string, userAgent: string): string {
  return createHmac('sha256', dailyKey(secret, now)).update(`${ip}\n${userAgent}`).digest('hex');
}

/** The rate-limit subject: HMAC(day key, IP) — the limiter never holds an address either. */
export function ipKey(secret: string, now: Date, ip: string): string {
  return createHmac('sha256', dailyKey(secret, now)).update(`ip\n${ip}`).digest('hex');
}
