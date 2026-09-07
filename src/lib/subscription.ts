// The tenant's subscription and its entitlements, read from the database
// (#1731, epic #1727). Server-only: it imports prisma. The pure plan→feature
// matrix lives in src/lib/plans.ts and stays client-safe.
//
// This is the ONE door between "what the database says a tenant bought" and
// "may this tenant use feature X". A feature check written inline at a call
// site is how a paywall leaks: the checks drift apart, one of them forgets the
// hand-granted pilot, and nobody notices until a customer either loses access
// they paid for or gets access they did not.
//
// NOTHING IS GATED YET. No existing call site reads this module — the four
// planGate call sites still read `Organization.plan` through
// src/lib/orgPlans.ts. Landing the storage, the matrix and this resolver
// without changing behaviour is deliberate (#1731); moving the gates over is a
// later task in the epic.

import type { Subscription } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { PremiumFeature } from '@/lib/entitlementsCatalog';
import { LEGACY_PLAN_MAP, resolveEntitlements, type EntitlementResolution, type PlanKey } from '@/lib/plans';

export { LEGACY_PLAN_MAP } from '@/lib/plans';

// The plan a tenant gets when it has no Subscription row yet: whatever its
// legacy `Organization.plan` enum said, translated through the ONE map both
// this accessor and the deploy backfill use. An org whose plan is unreadable
// falls back to the free tier — never to a paid one.
function planKeyForLegacyPlan(plan: string | null | undefined): PlanKey {
  if (plan && plan in LEGACY_PLAN_MAP) return LEGACY_PLAN_MAP[plan as keyof typeof LEGACY_PLAN_MAP];
  return LEGACY_PLAN_MAP.FREE;
}

// The tenant's subscription, created on first read if it does not exist.
//
// Belt and braces next to prisma/backfill-org-subscription.mjs: the backfill
// gives every org that existed at deploy time a row, and this covers every org
// created AFTER it ran — a new tenant, a freshly seeded topic environment, a
// restored database — so every later billing screen may assume the row exists
// without anyone re-running a script.
//
// Safe to call concurrently: `orgId` is unique, so two racing creates end with
// one row and one caught P2002, after which the loser reads the winner's row.
export async function getOrCreateSubscription(orgId: string): Promise<Subscription> {
  const existing = await prisma.subscription.findUnique({ where: { orgId } });
  if (existing) return existing;

  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  if (!org) throw new Error(`getOrCreateSubscription: no organization ${orgId}`);

  try {
    return await prisma.subscription.create({
      data: {
        orgId,
        planKey: planKeyForLegacyPlan(org.plan),
        status: 'ACTIVE',
        interval: 'MONTHLY',
      },
    });
  } catch {
    // Lost the race (or the row appeared some other way). Re-read rather than
    // reporting a failure: the only thing the caller asked for is a row, and
    // there is exactly one.
    const row = await prisma.subscription.findUnique({ where: { orgId } });
    if (row) return row;
    throw new Error(`getOrCreateSubscription: could not create or read a subscription for ${orgId}`);
  }
}

// Everything a tenant may use right now: its plan's features (while the
// subscription's status carries them) plus the grants that have not expired,
// with the limits that apply. One indexed lookup plus one small collection
// read; safe on a request path.
//
// The expiry filter lives HERE, not in plans.ts, because the matrix has no
// clock on purpose. `now` is injectable so a caller (and a test) can ask the
// question as of a specific moment instead of implicitly trusting the wall.
export async function resolveOrgEntitlements(
  orgId: string | null | undefined,
  now: Date = new Date(),
): Promise<EntitlementResolution> {
  // No tenant resolves → the free tier. Not "everything": a request that
  // cannot name its org must never be the one that unlocks the paid product.
  if (!orgId) return resolveEntitlements({});

  const [subscription, grants] = await Promise.all([
    prisma.subscription.findUnique({
      where: { orgId },
      select: { planKey: true, status: true },
    }),
    prisma.orgEntitlement.findMany({
      where: {
        orgId,
        // Row present = feature on, until it expires. A NULL expiresAt is a
        // permanent grant.
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { feature: true },
    }),
  ]);

  // No row yet? Answer from the legacy plan enum rather than refusing — the
  // lazy create belongs to getOrCreateSubscription(), and a read should not
  // write. The org is looked up only in that (rare) case.
  if (!subscription) {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
    return resolveEntitlements({
      planKey: planKeyForLegacyPlan(org?.plan),
      status: 'ACTIVE',
      grants: grants.map((g) => g.feature),
    });
  }

  return resolveEntitlements({
    planKey: subscription.planKey,
    status: subscription.status,
    grants: grants.map((g) => g.feature),
  });
}

// May this tenant use this feature? The single question a gate should ask —
// one call, one answer, whether the feature came with the plan or was granted
// by hand.
export async function orgEntitled(
  orgId: string | null | undefined,
  feature: PremiumFeature,
  now: Date = new Date(),
): Promise<boolean> {
  const resolution = await resolveOrgEntitlements(orgId, now);
  return resolution.features.includes(feature);
}
