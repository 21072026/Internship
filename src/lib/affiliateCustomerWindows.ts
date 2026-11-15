// Customers' commission windows, read from the engine (docs/affiliate-module.md,
// #3557) — shared by the partner portal (one partner) and the admin customer
// list (#3538, the partners of one page). The window is the engine's
// `windowEndsAt` over the partner's WHOLE payment history (the customer's
// ordinal depends on the partner's other customers), cut by a STOP_ALL notice:
// the same value the window-notice mail names (#3556), never a second calculation.

import { prisma } from '@/lib/prisma';
import { evaluatePartner, parseCommissionPlan, type CommissionPlan, type PartnerEvaluation } from '@/lib/affiliateCommissionRule';
import { customerWindows, planHasPercent, readWindowNoticeDays, type CustomerWindow } from '@/lib/affiliateWindowNoticeRule';

/** A customer's window as a screen renders it: dates as ISO strings. */
export type WindowView = { kind: 'none' } | { kind: 'unlimited' } | { kind: 'ends'; endsAt: string; ended: boolean };

export const windowView = (w: CustomerWindow | undefined): WindowView =>
  !w || w.kind === 'none' ? { kind: 'none' } : w.kind === 'unlimited' ? w : { kind: 'ends', endsAt: w.endsAt.toISOString(), ended: w.ended };

export interface PartnerWindows {
  evaluation: PartnerEvaluation;
  windows: Map<string, CustomerWindow>;
}

/**
 * The windows of every customer of the given partners of `orgId`. `plan` is null
 * when the programme has no plan with a percent phase — there is no window to
 * show. Every requested partner of the org is in `partners`, a partner without
 * payments with an empty map; a partner id of another org is absent.
 */
export async function customerWindowsByPartner(
  orgId: string,
  partnerIds: string[],
  now = new Date(),
): Promise<{ plan: CommissionPlan | null; leadDays: number; partners: Map<string, PartnerWindows> }> {
  const partners = new Map<string, PartnerWindows>();
  const settings = await prisma.affiliateProgramSettings.findUnique({ where: { orgId }, select: { plan: true, windowNoticeDays: true } });
  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  if (!parsed?.ok || !planHasPercent(parsed.plan) || partnerIds.length === 0) return { plan: null, leadDays: 0, partners };
  const plan = parsed.plan;

  const [rows, payments] = await Promise.all([
    prisma.affiliatePartner.findMany({ where: { orgId, id: { in: partnerIds } }, select: { id: true, noticeEffectiveAt: true } }),
    prisma.affiliatePayment.findMany({
      where: { orgId, customer: { partnerId: { in: partnerIds } } },
      select: { id: true, customerId: true, amountMinor: true, currency: true, receivedAt: true, customer: { select: { partnerId: true } } },
    }),
  ]);
  const byPartner = new Map<string, { id: string; customerId: string; amountMinor: number; currency: string; receivedAt: Date }[]>();
  for (const { customer, ...fact } of payments) {
    const list = byPartner.get(customer.partnerId) ?? [];
    list.push(fact);
    byPartner.set(customer.partnerId, list);
  }
  for (const row of rows) {
    const facts = { noticeEffectiveAt: row.noticeEffectiveAt ?? null };
    const evaluation = evaluatePartner(plan, facts, byPartner.get(row.id) ?? []);
    partners.set(row.id, { evaluation, windows: customerWindows({ plan, partner: facts, evaluation, now }) });
  }
  return { plan, leadDays: readWindowNoticeDays(settings?.windowNoticeDays), partners };
}
