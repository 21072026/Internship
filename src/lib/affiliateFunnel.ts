// A partner's funnel and threshold progress — the ONE server-side aggregate the
// partner portal (#3543) and the admin screens (#3544) read, so both show the
// same numbers (docs/affiliate-module.md, "The funnel"). The rules are pure in
// src/lib/affiliateFunnelRule.ts; the statuses come from
// `partnerCustomerStatusCounts()` (src/lib/affiliateCustomerStatus.ts) and the
// paying-customer ordinal from the commission engine's `evaluatePartner()`.
//
// Every query names `orgId` explicitly; a partner id of another org counts
// nothing. A fixed number of queries whatever the number of partners.

import { prisma } from '@/lib/prisma';
import { evaluatePartner, parseCommissionPlan } from '@/lib/affiliateCommissionRule';
import { emptyStatusCounts } from '@/lib/affiliateCustomerStatusRule';
import { partnerCustomerStatusCounts } from '@/lib/affiliateCustomerStatus';
import {
  funnelFromCounts,
  periodStart,
  thresholdProgress,
  type Funnel,
  type FunnelPeriod,
  type ThresholdProgress,
} from '@/lib/affiliateFunnelRule';

/**
 * The funnel per partner of `orgId` for `period`. `partnerIds` narrows to those
 * partners (the portal passes its own one, and gets an all-zero funnel when it
 * has nothing yet); omitted, every partner with a click or a customer.
 */
export async function partnerFunnels(
  orgId: string,
  options: { partnerIds?: string[]; period: FunnelPeriod; now?: Date },
): Promise<Map<string, Funnel>> {
  const now = options.now ?? new Date();
  const from = periodStart(options.period, now);
  const partnerFilter = options.partnerIds ? { partnerId: { in: options.partnerIds } } : {};
  const [clickRows, statusCounts] = await Promise.all([
    options.partnerIds?.length === 0
      ? []
      : prisma.affiliateClickDaily.groupBy({
          by: ['partnerId'],
          where: { orgId, ...partnerFilter, ...(from ? { day: { gte: from } } : {}) },
          _sum: { clicks: true, uniqueClicks: true },
        }),
    partnerCustomerStatusCounts(orgId, { partnerIds: options.partnerIds, registeredFrom: from, now }),
  ]);
  const clicks = new Map(clickRows.map((r) => [r.partnerId, { clicks: r._sum.clicks ?? 0, uniqueClicks: r._sum.uniqueClicks ?? 0 }]));
  const ids = new Set([...(options.partnerIds ?? []), ...clicks.keys(), ...statusCounts.keys()]);
  const result = new Map<string, Funnel>();
  for (const id of ids) {
    result.set(id, funnelFromCounts(clicks.get(id) ?? { clicks: 0, uniqueClicks: 0 }, statusCounts.get(id) ?? emptyStatusCounts()));
  }
  return result;
}

/**
 * Progress towards the plan's switch to a percent, per partner of `orgId`,
 * under the organisation's CURRENT plan — the same evaluation the payment
 * writer runs, so "7 / 10" is the engine's seventh customer. The map is empty
 * when the plan has no threshold (the indicator is then not shown at all).
 */
export async function partnerThresholds(
  orgId: string,
  options: { partnerIds?: string[] } = {},
): Promise<Map<string, ThresholdProgress>> {
  const result = new Map<string, ThresholdProgress>();
  if (options.partnerIds?.length === 0) return result;
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true } });
  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  const plan = parsed?.ok ? parsed.plan : null;
  if (!plan || thresholdProgress(plan, 0, null) === null) return result;

  const idFilter = options.partnerIds ? { id: { in: options.partnerIds } } : {};
  const [partners, payments] = await Promise.all([
    prisma.affiliatePartner.findMany({ where: { orgId, ...idFilter }, select: { id: true, noticeEffectiveAt: true } }),
    prisma.affiliatePayment.findMany({
      where: { orgId, ...(options.partnerIds ? { customer: { partnerId: { in: options.partnerIds } } } : {}) },
      select: { id: true, customerId: true, amountMinor: true, currency: true, receivedAt: true, customer: { select: { partnerId: true } } },
    }),
  ]);
  const byPartner = new Map<string, typeof payments>();
  for (const p of payments) {
    const list = byPartner.get(p.customer.partnerId);
    if (list) list.push(p);
    else byPartner.set(p.customer.partnerId, [p]);
  }
  for (const partner of partners) {
    const evaluation = evaluatePartner(plan, { noticeEffectiveAt: partner.noticeEffectiveAt }, byPartner.get(partner.id) ?? []);
    const progress = thresholdProgress(plan, evaluation.customerOrder.length, evaluation.switchedAt);
    if (progress) result.set(partner.id, progress);
  }
  return result;
}
