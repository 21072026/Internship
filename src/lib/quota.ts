import { prisma } from '@/lib/prisma';
import { defaultOrgId } from '@/lib/defaultOrg';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { getOrCreateSubscription } from '@/lib/subscription';
import { planLimits } from '@/lib/plans';
import { countAdminSeats, countOrgCompanies, countOrgPrograms } from '@/lib/metering';
import { QUOTA_LIMIT_KEY, quotaAllows, type QuotaMetric, type QuotaResult } from '@/lib/quotaRule';

// enforceQuota() at provisioning time (#1752): admin seats, companies and
// programmes, read against the tenant's SUBSCRIPTION plan (src/lib/plans.ts)
// and counted live — these are point-in-time capacities, so a request reads the
// one count it needs rather than a nightly rollup that could be a day stale.
// The rule (and the free-core line: no MENTOR/MENTEE seat exists) is
// src/lib/quotaRule.ts.
//
// FAILS OPEN, like checkActiveRelationLimit():
//   - no org resolves;
//   - the DEFAULT organization — the installation's own tenant. On the hosted
//     service it is grandfathered ENTERPRISE (unlimited) anyway; on a
//     self-hosted AGPL install it is the operator's only tenant, and our SaaS
//     plan bands must never cap it;
//   - an org whose product has no `mentorship` capability (MARKETING): these
//     bands are the programme price list's, MARKETING has its own
//     (src/lib/marketingPlans.ts) and no seat model yet;
//   - a null limit.

const OPEN = (metric: QuotaMetric, usage = 0): QuotaResult => ({ allowed: true, metric, plan: null, limit: null, usage });

async function usageOf(orgId: string, metric: QuotaMetric, pendingAdminInvites: boolean): Promise<number> {
  switch (metric) {
    case 'ADMIN_SEATS': {
      const seats = await countAdminSeats(orgId);
      if (!pendingAdminInvites) return seats;
      // An open ADMIN invitation holds a seat: otherwise ten invitations sent
      // at once all pass and the band is exceeded the day they are accepted.
      const pending = await prisma.invitationToken.count({
        where: { orgId, role: 'ADMIN', used: false, revokedAt: null, expiresAt: { gt: new Date() } },
      });
      return seats + pending;
    }
    case 'COMPANIES':
      return countOrgCompanies(orgId);
    case 'PROGRAMS':
      return countOrgPrograms(orgId);
  }
}

export async function enforceQuota(
  orgId: string | null | undefined,
  metric: QuotaMetric,
  opts: { adding?: number; pendingAdminInvites?: boolean } = {},
): Promise<QuotaResult> {
  if (!orgId || orgId === (await defaultOrgId())) return OPEN(metric);
  if (!(await shellCapabilities(orgId)).includes('mentorship')) return OPEN(metric);
  const sub = await getOrCreateSubscription(orgId);
  const limit = planLimits(sub.planKey)[QUOTA_LIMIT_KEY[metric]];
  if (limit === null) return OPEN(metric);
  const usage = await usageOf(orgId, metric, opts.pendingAdminInvites ?? false);
  return { allowed: quotaAllows(limit, usage, opts.adding ?? 1), metric, plan: sub.planKey, limit, usage };
}
