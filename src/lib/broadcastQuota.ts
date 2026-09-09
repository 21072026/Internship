// Per-org broadcast sending quota (#1754, story #1746).
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Every tenant broadcasts from the SAME sending domain. A burst of complaints
// against one org's blast lands the whole domain in everybody's spam folder,
// which is the same constraint that makes the dormant sweep send no third mail
// ever (docs/dormant-first-contacts.md). So the cap here protects the shared
// reputation first and the commercial band second — it is a deliverability
// guard-rail that happens to line up with the plan matrix.
//
// ── WHAT IS METERED, AND WHAT IS FREE FOREVER ──────────────────────────────
// Only BROADCAST mail: an announcement sent by e-mail, and a newsletter issue.
// Both are enumerated once in `BROADCAST_EMAIL_CATEGORIES` below and nowhere
// else, so no call site ever compares a category string by hand.
//
// NOT metered, ever — this is the free-core promise and it is asserted by
// e2e/broadcast-quota.spec.ts with the band set to 0:
//   • 1:1 messages and message notification mail
//   • verification / invitation / password-reset mail
//   • meeting invitations and reminders, weekly digests, mentor digests
//   • dormant first-contact check-ins, stage deadlines, re-engagement
//   • the in-app half of an announcement (a bell notification is not mail, so
//     an announcement sent WITHOUT the e-mail box ticked is never metered)
//   • "Send me a test copy" of a newsletter — one mail to the admin's own
//     verified address, so that proofreading carefully cannot cost audience.
//
// ── HOW USAGE IS COUNTED ───────────────────────────────────────────────────
// From the rows that ALREADY EXIST, never from a counter of its own: a second
// tally is a number that can drift from what was really sent, and the whole
// point of a refusal is that the figure it names is true.
//
//   newsletter   → `NewsletterSend` rows (one per recipient, already written by
//                  the dispatcher) whose RECIPIENT belongs to the org.
//   announcement → `Announcement.emailedCount` (the fan-out's own tally of mail
//                  that actually left) of rows sent by one of the org's admins.
//
// The two attribution axes differ because the available rows do: a newsletter
// has a per-recipient row and fans out across tenants (#1667), so the recipient
// is the honest anchor; an announcement has only a counter, and it is always
// created by a signed-in ADMIN of the sending tenant, so the sender is. Neither
// model carries an `orgId` today (EmailLog does not either — that is #1556),
// and inventing one for a quota is not worth a schema change plus a backfill.
//
// ── THE BAND ───────────────────────────────────────────────────────────────
// `min(plan band, operator setting)` over a CALENDAR MONTH (UTC). The plan band
// is `PlanLimits.monthlyBroadcastRecipients` (src/lib/plans.ts — Community 250,
// Program 2 000, Program Plus 10 000, Enterprise unlimited); the operator
// setting `broadcastMonthlyRecipients` can only ever TIGHTEN it. That direction
// is the load-bearing part: a cap a tenant's own admin could raise is not a
// protection of anybody else's deliverability, so the setting is a floor, never
// a lift, whichever layer it is written in.
//
// ── FAIL-OPEN WHEN NO TENANT RESOLVES ──────────────────────────────────────
// Same stance as src/lib/planGate.ts: a request that cannot name its org is not
// blocked. Today's single-tenant production runs on the grandfathered
// ENTERPRISE "default" org, whose band is unlimited, so this module is a no-op
// there by construction.

import { prisma } from '@/lib/prisma';
import { getSetting } from '@/lib/settings';
import { NEWSLETTER_EMAIL_CATEGORY } from '@/lib/newsletter';
import { resolveOrgEntitlements } from '@/lib/subscription';
import type { PlanKey } from '@/lib/plans';

/**
 * The `EmailLog.category` values that count as a broadcast — the ONE list, so
 * "is this metered?" has a single answer. Everything absent from it is free
 * core and stays free core.
 */
export const BROADCAST_EMAIL_CATEGORIES = ['announcement', NEWSLETTER_EMAIL_CATEGORY] as const;
export type BroadcastCategory = (typeof BROADCAST_EMAIL_CATEGORIES)[number];

/** Is this mail category metered against the broadcast band? */
export function isBroadcastEmailCategory(category: string | null | undefined): category is BroadcastCategory {
  return !!category && (BROADCAST_EMAIL_CATEGORIES as readonly string[]).includes(category);
}

/** The operator tunable; its default and reasoning live in SETTING_DEFAULTS. */
export const BROADCAST_QUOTA_SETTING = 'broadcastMonthlyRecipients' as const;

/** Machine-readable refusal code, rendered into copy by the composers. */
export const BROADCAST_QUOTA_CODE = 'broadcast_quota_exceeded' as const;

export interface BroadcastMonth {
  /** First instant of the current calendar month, UTC. */
  start: Date;
  /** First instant of the next one — when the meter goes back to zero. */
  resetsAt: Date;
}

/**
 * The window, in UTC rather than server-local time: the band is a published
 * number and "which month is it" must not depend on which timezone the
 * container happens to boot with.
 */
export function broadcastMonth(now: Date = new Date()): BroadcastMonth {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, resetsAt };
}

/**
 * One counter per metered category, keyed by the category itself — so adding a
 * broadcast category to `BROADCAST_EMAIL_CATEGORIES` without teaching this map
 * how to count it is a type error rather than a silently unmetered blast.
 */
const USED_THIS_MONTH: Record<BroadcastCategory, (orgId: string, since: Date) => Promise<number>> = {
  announcement: async (orgId, since) => {
    // Only an ADMIN can broadcast (the route requires the role), and admin
    // seats are capped in single digits by every plan, so this stays a small
    // `IN (…)` rather than a list of the whole tenant.
    const admins = await prisma.user.findMany({ where: { orgId, role: 'ADMIN' }, select: { id: true } });
    if (admins.length === 0) return 0;
    const agg = await prisma.announcement.aggregate({
      _sum: { emailedCount: true },
      where: { sentById: { in: admins.map((a) => a.id) }, createdAt: { gte: since } },
    });
    return agg._sum.emailedCount ?? 0;
  },
  [NEWSLETTER_EMAIL_CATEGORY]: (orgId, since) =>
    prisma.newsletterSend.count({
      // SENT and FAILED both reached the relay and both can generate a
      // complaint or a bounce; SKIPPED never left the process, so it costs the
      // sending domain nothing and is not counted.
      where: { sentAt: { gte: since }, status: { in: ['SENT', 'FAILED'] }, user: { orgId } },
    }),
};

/** Recipients this org has already broadcast to in the current month. */
export async function broadcastRecipientsUsed(orgId: string, now: Date = new Date()): Promise<number> {
  const { start } = broadcastMonth(now);
  const counts = await Promise.all(
    BROADCAST_EMAIL_CATEGORIES.map((category) => USED_THIS_MONTH[category](orgId, start)),
  );
  return counts.reduce((sum, n) => sum + n, 0);
}

/** `''` / anything unparseable = "no override"; a number = a cap. */
function parseOverride(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface BroadcastBand {
  /** The effective cap for the month; `null` = unlimited. */
  limit: number | null;
  /** The plan the band came from, before any operator override. */
  planKey: PlanKey | null;
  /** True when an operator setting is what actually bites. */
  overridden: boolean;
}

/**
 * The band for one org: the plan's monthly recipient allowance, tightened (never
 * raised) by the operator setting from either the tenant's own layer or the
 * global one.
 */
export async function resolveBroadcastBand(orgId: string): Promise<BroadcastBand> {
  const [entitlements, globalRaw, orgRaw] = await Promise.all([
    resolveOrgEntitlements(orgId),
    // Read explicitly per layer: `getSetting(key, orgId)` alone would let a
    // tenant row REPLACE the global one, and this cap may only be tightened.
    getSetting(BROADCAST_QUOTA_SETTING, null),
    getSetting(BROADCAST_QUOTA_SETTING, orgId),
  ]);

  const planLimit = entitlements.limits.monthlyBroadcastRecipients;
  const overrides = [parseOverride(globalRaw), parseOverride(orgRaw)].filter((n): n is number => n !== null);
  const candidates = [...(planLimit == null ? [] : [planLimit]), ...overrides];

  return {
    limit: candidates.length === 0 ? null : Math.min(...candidates),
    planKey: entitlements.planKey,
    overridden: overrides.length > 0 && Math.min(...candidates) !== planLimit,
  };
}

export interface BroadcastQuotaCheck {
  allowed: boolean;
  /** null = unlimited (nothing was counted, and nothing needed to be). */
  limit: number | null;
  used: number;
  requested: number;
  /** null when unlimited. */
  remaining: number | null;
  resetsAt: Date;
  planKey: PlanKey | null;
  orgId: string | null;
}

/**
 * May this org broadcast to `requested` more recipients right now?
 *
 * THE WHOLE SEND IS THE UNIT. The caller passes the recipient count of the
 * entire fan-out BEFORE a single message leaves, and a send that would cross the
 * band is refused whole. Truncating one instead would leave an issue partly
 * delivered — and a sent newsletter issue is immutable and undeletable
 * (docs/newsletter.md), so "the rest of the list" could never be reached again.
 *
 * It is a check, not a lock: two admins pressing Send in the same second can
 * both pass it and overshoot the band by at most the smaller of the two sends.
 * That is a deliberate trade — the alternative is serialising every broadcast
 * behind a row lock for a limit whose purpose is a monthly average — and it is
 * self-correcting, because usage is derived from the rows that were actually
 * written, so the next check sees the overshoot and refuses.
 */
export async function checkBroadcastQuota(options: {
  orgId: string | null | undefined;
  requested: number;
  now?: Date;
}): Promise<BroadcastQuotaCheck> {
  const { orgId, requested } = options;
  const now = options.now ?? new Date();
  const { resetsAt } = broadcastMonth(now);
  const unlimited = (used = 0): BroadcastQuotaCheck => ({
    allowed: true,
    limit: null,
    used,
    requested,
    remaining: null,
    resetsAt,
    planKey: null,
    orgId: orgId ?? null,
  });

  // Fail open: a request that cannot name its tenant is not the one to block.
  if (!orgId) return unlimited();

  const band = await resolveBroadcastBand(orgId);
  if (band.limit == null) return { ...unlimited(), planKey: band.planKey };

  const used = await broadcastRecipientsUsed(orgId, now);
  return {
    // Nothing to send is never a breach, even for an org already over its band.
    allowed: requested <= 0 || used + requested <= band.limit,
    limit: band.limit,
    used,
    requested,
    remaining: Math.max(0, band.limit - used),
    resetsAt,
    planKey: band.planKey,
    orgId,
  };
}

/**
 * The 403 body every refusing route returns, so the shape is identical wherever
 * the block happens.
 *
 * `error` stays an English literal for logs and API clients — the human-facing
 * sentence is rendered by the composer from `code` plus these figures, because a
 * server-authored message is never shown verbatim (see src/lib/apiErrorMessage.ts).
 */
export function broadcastQuotaError(check: BroadcastQuotaCheck) {
  return {
    error:
      `Broadcast quota reached: ${check.used}/${check.limit} recipients used this month, ` +
      `and this send would add ${check.requested}. Nothing was sent. The meter resets on ` +
      `${check.resetsAt.toISOString().slice(0, 10)}.`,
    code: BROADCAST_QUOTA_CODE,
    limit: check.limit,
    used: check.used,
    requested: check.requested,
    remaining: check.remaining,
    resetsAt: check.resetsAt.toISOString(),
    plan: check.planKey,
  };
}

/**
 * The composer's "you have used X of Y this month" payload.
 *
 * `used` is null exactly when `limit` is: an unlimited band counts nothing, so
 * there is no month-to-date query to pay for and no number to show — the
 * composer renders "unlimited" instead of a fraction.
 */
export async function broadcastQuotaStatus(orgId: string | null | undefined, now: Date = new Date()) {
  const check = await checkBroadcastQuota({ orgId, requested: 0, now });
  return {
    limit: check.limit,
    used: check.limit == null ? null : check.used,
    remaining: check.remaining,
    resetsAt: check.resetsAt.toISOString(),
    plan: check.planKey,
  };
}
