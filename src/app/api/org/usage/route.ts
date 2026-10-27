import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withTenantScope } from '@/lib/orgContext';
import { resolveOrgId } from '@/lib/orgScope';
import { requireCapability } from '@/lib/capabilityGate';
import { getOrCreateSubscription } from '@/lib/subscription';
import { resolveBroadcastBand } from '@/lib/broadcastQuota';
import { currentPeriod } from '@/lib/meteringRules';
import { trailingPeriods } from '@/lib/billingSummary';
import { USAGE_HISTORY_PERIODS, USAGE_METRIC_NAMES, buildUsageSummary } from '@/lib/usageSummary';

// The caller's own usage (#1763): every metered number against its plan limit,
// four periods of trend. The usage tab of /admin/billing reads it; the sibling
// of GET /api/org/billing and shaped exactly like it.
//
// TAKES NO orgId OF ANY KIND — the org is the session's (resolveOrgId), and the
// explicit `orgId` filter below is the guarantee, not withTenantScope.
//
// READS THE LEDGER ONLY. Every value is a UsageRollup row the nightly job wrote
// (src/lib/jobs/usageRollup.ts); nothing here scans an activity, AI or mail
// table, so the screen costs the same for a tenant of ten pairs and of ten
// thousand. The active-pair row is the same row the plan tab shows.
//
// The programme-side meter only, like /api/org/billing: an org without the
// `mentorship` capability (MARKETING) is refused.
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
    const [subscription, rollups, broadcast] = await Promise.all([
      getOrCreateSubscription(orgId),
      prisma.usageRollup.findMany({
        where: { orgId, metric: { in: [...USAGE_METRIC_NAMES] }, period: { in: trailingPeriods(period, USAGE_HISTORY_PERIODS) } },
        select: { metric: true, period: true, value: true, computedAt: true },
      }),
      // The band the broadcast gate enforces (plan allowance, tightened by an
      // operator cap) — a settings read, not a scan.
      resolveBroadcastBand(orgId),
    ]);

    return NextResponse.json(
      buildUsageSummary({
        planKey: subscription.planKey,
        period,
        rollups: rollups.map((r) => ({ ...r, computedAt: r.computedAt.toISOString() })),
        broadcastLimit: broadcast.limit,
      }),
    );
  });
}
