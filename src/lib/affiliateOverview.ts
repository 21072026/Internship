// The affiliate programme's overview tab (docs/affiliate-module.md, #3173): what the
// programme holds right now, for every admin who may read it (`affiliate.read`).
//
// Read only, and a FIXED number of queries whatever the programme's size — six,
// all aggregates or single rows, run together. A migrated programme holds
// thousands of partners, so nothing here loops over them. The commission totals
// are the same query as the Commissions tab's (`listCommissions().totals`: every
// status, the whole programme), and the latest payout is the Payouts tab's first
// row (newest transfer first), so the three screens cannot disagree.

import { prisma } from '@/lib/prisma';
import { parseCommissionPlan } from '@/lib/affiliateCommissionRule';
import { COMMISSION_STATUSES, type CommissionStatus } from '@/lib/affiliateCommissions';

export const PARTNER_STATUSES = ['ACTIVE', 'SUSPENDED', 'TERMINATED'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export interface AffiliateOverview {
  setup: { plan: boolean; contract: boolean; partners: boolean };
  /** The plan's currency, or EUR (the only one for now) before there is a plan. */
  currency: string;
  partners: Record<PartnerStatus, number>;
  customers: number;
  commissions: Record<CommissionStatus, { count: number; amountMinor: number }>;
  payouts: { count: number; amountMinor: number };
  latestPayout: { id: string; paidAt: string; amountMinor: number; currency: string; partner: { id: string; code: string; displayName: string }; commissions: number } | null;
}

/** The six queries, behind the client they run on, so a test can count them. */
export async function affiliateOverview(orgId: string, db: Pick<typeof prisma, 'affiliateProgramSettings' | 'affiliatePartner' | 'affiliateCustomer' | 'affiliateCommission' | 'affiliatePayout'> = prisma): Promise<AffiliateOverview> {
  const where = { orgId };
  const [settings, partnerGroups, customers, commissionGroups, payoutSum, latest] = await Promise.all([
    db.affiliateProgramSettings.findUnique({ where, select: { plan: true, contractVersion: true } }),
    db.affiliatePartner.groupBy({ by: ['status'], where, _count: { _all: true } }),
    db.affiliateCustomer.count({ where }),
    db.affiliateCommission.groupBy({ by: ['status'], where, _count: { _all: true }, _sum: { amountMinor: true } }),
    db.affiliatePayout.aggregate({ where, _count: { _all: true }, _sum: { amountMinor: true } }),
    db.affiliatePayout.findFirst({
      where,
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        paidAt: true,
        amountMinor: true,
        currency: true,
        partner: { select: { id: true, code: true, displayName: true } },
        _count: { select: { commissions: true } },
      },
    }),
  ]);

  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  const partners = Object.fromEntries(PARTNER_STATUSES.map((s) => [s, partnerGroups.find((g) => g.status === s)?._count._all ?? 0])) as Record<PartnerStatus, number>;
  const commissions = Object.fromEntries(
    COMMISSION_STATUSES.map((s) => {
      const g = commissionGroups.find((x) => x.status === s);
      return [s, { count: g?._count._all ?? 0, amountMinor: g?._sum.amountMinor ?? 0 }];
    }),
  ) as Record<CommissionStatus, { count: number; amountMinor: number }>;

  return {
    setup: {
      plan: parsed?.ok === true,
      contract: (settings?.contractVersion ?? 0) > 0,
      partners: PARTNER_STATUSES.some((s) => partners[s] > 0),
    },
    currency: parsed?.ok ? parsed.plan.currency : 'EUR',
    partners,
    customers,
    commissions,
    payouts: { count: payoutSum._count._all, amountMinor: payoutSum._sum.amountMinor ?? 0 },
    latestPayout: latest
      ? {
          id: latest.id,
          paidAt: latest.paidAt.toISOString(),
          amountMinor: latest.amountMinor,
          currency: latest.currency,
          partner: latest.partner,
          commissions: latest._count.commissions,
        }
      : null,
  };
}
