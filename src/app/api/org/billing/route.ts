import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { getOrCreateSubscription } from '@/lib/subscription';
import { currentPeriod } from '@/lib/meteringRules';
import { BILLING_METRICS, buildBillingSummary, trailingPeriods } from '@/lib/billingSummary';

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
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.user.role !== 'ADMIN') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const orgId = resolveOrgId(session);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 403 });
  const capGate = await requireCapability(orgId, 'mentorship');
  if (capGate) return capGate;

  return withTenantScope(session, async () => {
    const period = currentPeriod();
    const periods = trailingPeriods(period);
    const [subscription, rollups] = await Promise.all([
      getOrCreateSubscription(orgId),
      prisma.usageRollup.findMany({
        where: { orgId, metric: { in: [...BILLING_METRICS] }, period: { in: periods } },
        select: { metric: true, period: true, value: true, computedAt: true },
      }),
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

    return NextResponse.json(summary);
  });
}
