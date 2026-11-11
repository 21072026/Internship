// The admin's partner funnel board (docs/affiliate-module.md § The funnel, #3544)
// — the server half. The numbers are the shared funnel's (src/lib/affiliateFunnel.ts:
// `partnerFunnels()` and `partnerThresholds()`, which the partner portal reads
// too), so admin and portal cannot disagree; this file only joins them to the
// partner list and adds the admin-only commission-window warning. The rules are
// pure in src/lib/affiliateFunnelBoardRule.ts.
//
// A FIXED number of queries whatever the programme's size: the partners, the
// shared funnel and threshold queries, and for the window warning the settings
// row, every customer's status and the first valid payment per customer as one
// `groupBy`. Every query names `orgId` explicitly.

import { prisma } from '@/lib/prisma';
import { parseCommissionPlan } from '@/lib/affiliateCommissionRule';
import { partnerCustomerStatuses } from '@/lib/affiliateCustomerStatus';
import { partnerFunnels, partnerThresholds } from '@/lib/affiliateFunnel';
import { periodStart, type Funnel, type FunnelPeriod } from '@/lib/affiliateFunnelRule';
import { emptyFunnel, funnelBadges, funnelRates, funnelTotal, windowEndingSoon, type FunnelBadge, type FunnelBoardRow } from '@/lib/affiliateFunnelBoardRule';

export interface FunnelBoardPartnerRow extends FunnelBoardRow {
  code: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
  windowEndingSoon: number;
  badges: FunnelBadge[];
}

export interface FunnelBoard {
  period: FunnelPeriod;
  /** The period's first instant (UTC), null for "all". */
  from: string | null;
  /** The plan's `switchAtCustomer`, null when the plan has no switch to a percent. */
  switchAtCustomer: number | null;
  rows: FunnelBoardPartnerRow[];
  total: Funnel & { registrationRate: number | null; payingRate: number | null };
}

/** Every partner of `orgId` with its funnel for `period`, plus the org total. Unsorted. */
export async function affiliateFunnelBoard(orgId: string, options: { period: FunnelPeriod; now?: Date }): Promise<FunnelBoard> {
  const now = options.now ?? new Date();
  const settingsRow = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true } });
  const parsed = settingsRow?.plan ? parseCommissionPlan(settingsRow.plan) : null;
  const plan = parsed?.ok ? parsed.plan : null;

  const [partners, funnels, thresholds, statuses, firstPayments] = await Promise.all([
    prisma.affiliatePartner.findMany({
      where: { orgId },
      select: { id: true, code: true, displayName: true, status: true, noticeEffectiveAt: true },
      orderBy: { id: 'asc' },
    }),
    partnerFunnels(orgId, { period: options.period, now }),
    partnerThresholds(orgId),
    // Lifetime, whatever the period: the window belongs to the commission engine.
    partnerCustomerStatuses(orgId, { now }),
    // The engine's "first valid payment": positive and in the plan's currency.
    // Without a plan an impossible currency keeps the query count fixed.
    prisma.affiliatePayment.groupBy({
      by: ['customerId'],
      where: { orgId, amountMinor: { gt: 0 }, currency: plan?.currency ?? '' },
      _min: { receivedAt: true },
    }),
  ]);

  const firstValid = new Map(firstPayments.map((p) => [p.customerId, p._min.receivedAt ?? null]));
  const customersOf = new Map<string, { status: string; firstValidPaymentAt: Date | null }[]>();
  for (const c of statuses) {
    const list = customersOf.get(c.partnerId) ?? [];
    list.push({ status: c.status, firstValidPaymentAt: firstValid.get(c.id) ?? null });
    customersOf.set(c.partnerId, list);
  }

  const rows: FunnelBoardPartnerRow[] = partners.map((p) => {
    const funnel = funnels.get(p.id) ?? emptyFunnel();
    const threshold = thresholds.get(p.id) ?? null;
    const ending = plan
      ? windowEndingSoon({
          now,
          windowMonths: plan.windowMonths,
          afterNotice: plan.afterNotice,
          noticeEffectiveAt: p.noticeEffectiveAt,
          switched: threshold?.reachedAt != null,
          customers: customersOf.get(p.id) ?? [],
        })
      : 0;
    return {
      ...funnel,
      ...funnelRates(funnel),
      partnerId: p.id,
      code: p.code,
      displayName: p.displayName,
      status: p.status,
      toThreshold: threshold ? threshold.left : null,
      windowEndingSoon: ending,
      badges: funnelBadges({ ...funnel, windowEndingSoon: ending }),
    };
  });

  const total = funnelTotal(rows);
  return {
    period: options.period,
    from: periodStart(options.period, now)?.toISOString() ?? null,
    switchAtCustomer: plan && plan.percentBps > 0 ? plan.switchAtCustomer : null,
    rows,
    total: { ...total, ...funnelRates(total) },
  };
}
