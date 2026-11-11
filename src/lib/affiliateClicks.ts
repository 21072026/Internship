// The partner link's click redirect and daily counter — the server half
// (docs/affiliate-module.md § Link clicks, #3541). The rule is pure in
// src/lib/affiliateClickRule.ts.
//
// WHICH ORGANISATION. `/r/<code>` is signed out, so the host decides, through
// the same resolver as the public programme page and the application form
// (src/lib/publicHostOrg.ts): the org an operator mapped this hostname to,
// MARKETING, with the `affiliate` capability. A code is looked up in THAT org
// only, so another org's code is never counted on this host. A forged host
// header can at most add a click to another org's partner — the same trust
// note as the public form, and the same per-visitor limit applies.
//
// WHAT IS KEPT. One `AffiliateClickDaily` row per partner and UTC day. The rate
// limit and the "unique" check run in the shared rate-limit store under
// HMAC-derived keys (`ipKey`, `visitorKey`) that change every UTC day and expire
// by the end of it; the raw IP and user-agent are read from the request, hashed,
// and never written or logged — not even on a limit breach, which is why this
// file calls `rateLimit()` rather than `enforceRateLimit()` (that one records
// the client IP in the activity log).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { rateLimit } from '@/lib/rateLimit';
import { resolvePublicInquiryTarget } from '@/lib/publicHostOrg';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { appLinkOrigin, isServedHost } from '@/lib/servedHosts';
import { parseReferralUrl } from '@/lib/affiliateReferralRule';
import { CLICK_RATE_LIMIT, clickDay, ipKey, msUntilNextUtcDay, visitorKey } from '@/lib/affiliateClickRule';

/** The programme this host serves, with its referral URL; null when no programme answers here. */
export async function clickProgrammeForHost(
  hostHeader: string | null | undefined,
): Promise<{ orgId: string; referralUrl: string | null } | null> {
  const target = await resolvePublicInquiryTarget(hostHeader);
  if (!target.open || target.vertical !== 'MARKETING' || !target.orgId) return null;
  const orgId = target.orgId;
  if (!(await shellCapabilities(orgId)).includes('affiliate')) return null;
  // Sessionless: no tenant context is bound, so the org is named explicitly.
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { referralUrl: true } });
  return { orgId, referralUrl: settings?.referralUrl ?? null };
}

export type ClickOutcome = 'counted' | 'limited' | 'unknown_partner' | 'no_secret';

/**
 * Count one click of an ACTIVE partner of `orgId` whose code is `code`. The
 * caller has already decided the request is countable (`isCountableRequest`).
 * Runs after the response, so its timing tells the visitor nothing.
 */
export async function recordAffiliateClick(input: {
  orgId: string;
  code: string;
  ip: string;
  userAgent: string;
  now?: Date;
}): Promise<ClickOutcome> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return 'no_secret';
  const now = input.now ?? new Date();
  // The limit is spent by every countable request, known code or not, so a
  // flood of guessed codes is bounded before it reaches the database.
  if (!rateLimit(`affiliate-click:${ipKey(secret, now, input.ip)}`, CLICK_RATE_LIMIT).ok) return 'limited';

  const partner = await prisma.affiliatePartner.findFirst({
    where: { orgId: input.orgId, code: input.code, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!partner) return 'unknown_partner';

  // First sighting of this visitor key for this partner today = a unique click.
  // A window of limit 1 that ends at the next UTC midnight is exactly that.
  const unique = rateLimit(`affiliate-click-seen:${partner.id}:${visitorKey(secret, now, input.ip, input.userAgent)}`, {
    limit: 1,
    windowMs: msUntilNextUtcDay(now),
  }).ok;

  const day = clickDay(now);
  const write = () =>
    prisma.affiliateClickDaily.upsert({
      where: { partnerId_day: { partnerId: partner.id, day } },
      create: { orgId: input.orgId, partnerId: partner.id, day, clicks: 1, uniqueClicks: unique ? 1 : 0 },
      update: { clicks: { increment: 1 }, ...(unique ? { uniqueClicks: { increment: 1 } } : {}) },
    });
  try {
    await write();
  } catch (e) {
    // Two first clicks of the day raced on the create: the row exists now, so
    // the second attempt takes the update branch.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    await write();
  }
  return 'counted';
}

/** Count a click after the response; a failure is logged (without the visitor) and swallowed. */
export async function recordAffiliateClickQuietly(input: Parameters<typeof recordAffiliateClick>[0]): Promise<void> {
  try {
    await recordAffiliateClick(input);
  } catch (e) {
    logger.warning('affiliate click not counted', { orgId: input.orgId, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The tracked link a partner shares: `<org's public host>/r/<code>`. Null while
 * the org has no public host this deployment serves (the route resolves the org
 * from that host, so a link on any other host could not be counted) or no valid
 * referral URL to send the visitor on to.
 */
export function trackedReferralLink(publicHost: string | null | undefined, referralUrl: string | null | undefined, code: string): string | null {
  if (!publicHost || !isServedHost(publicHost)) return null;
  const parsed = parseReferralUrl(referralUrl);
  if (!parsed.ok || !parsed.url) return null;
  return `${appLinkOrigin(publicHost)}/r/${encodeURIComponent(code)}`;
}
