import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/authz';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { getOrCreateSubscription, resolveOrgEntitlements } from '@/lib/subscription';
import { superAdminWorld } from '@/lib/superAdmin';
import { currentPeriod } from '@/lib/meteringRules';
import { BILLING_METRICS, billingFeatureRows, buildBillingSummary, trailingPeriods } from '@/lib/billingSummary';

// The caller's own bill (#1739): plan, this month's active pairs against the
// band, and twelve months of history — for one tenant, the caller's.
//
// TAKES NO orgId OF ANY KIND. The org is the session's; a parameter would hand
// every tenant admin every other tenant's bill (MT_ENFORCE_ISOLATION is off on
// every deployment, so the explicit `orgId` filter below is the guarantee —
// withTenantScope is worn for consistency, not relied on).
//
// The pair count is READ from UsageRollup, never computed here: the definition
// is a scan across seven activity tables and belongs to the nightly rollup
// (docs/metering.md § The ledger). The rollup writes it with
// activeMatchedPairs(), so the number on the screen is that function's answer
// as of `computedAt`.
//
// The programme-side meter only: plans.ts is the internship product's price
// list, and a MARKETING org has no plan gate and no checkout
// (src/lib/marketingPlans.ts), so the route refuses an org without the
// `mentorship` capability exactly like the page does.
export async function GET(request: Request) {
  const gate = await requirePermission('org.settings.read', { request });
  if ('error' in gate) return gate.error;
  const { session } = gate;
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  const capGate = await requireCapability(orgId, 'mentorship');
  if (capGate) return capGate;

  return withTenantScope(session, async () => {
    const period = currentPeriod();
    const periods = trailingPeriods(period);
    const now = new Date();
    const [subscription, rollups, resolution, grants, world] = await Promise.all([
      getOrCreateSubscription(orgId),
      prisma.usageRollup.findMany({
        where: { orgId, metric: { in: [...BILLING_METRICS] }, period: { in: periods } },
        select: { metric: true, period: true, value: true, computedAt: true },
      }),
      // What the plan includes and what was granted on top (#1734) — the same
      // resolver entitled() asks, so the tab and every gate agree.
      resolveOrgEntitlements(orgId, now),
      prisma.orgEntitlement.findMany({
        where: { orgId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { feature: true, expiresAt: true },
      }),
      superAdminWorld(session),
    ]);

    const summary = buildBillingSummary({
      period,
      subscription: {
        planKey: subscription.planKey,
        status: subscription.status,
        interval: subscription.interval,
        educationDiscount: subscription.educationDiscount,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
      },
      rollups: rollups.map((r) => ({ ...r, computedAt: r.computedAt.toISOString() })),
    });

    return NextResponse.json({
      ...summary,
      features: billingFeatureRows(resolution, grants.map((g) => ({ feature: g.feature, expiresAt: g.expiresAt?.toISOString() ?? null }))),
      // Whether the grant form is offered. Presentation only — the write
      // endpoint (POST /api/admin/billing/entitlements) decides again.
      canGrant: world !== null,
    });
  });
}
