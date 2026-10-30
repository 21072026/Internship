// What a partner reads about itself in the portal (docs/affiliate-module.md, #3117).
//
// Every query is narrowed by `affiliateRowScope()` (src/lib/affiliateContractRule.ts)
// to the signed-in partner's own rows, with the partner taken from the session —
// never from the request. A row of another partner reads exactly like a row that
// does not exist (null → the page answers 404).
//
// A partner sees amounts, dates and statuses of its own customers' payments and
// commissions, and the customer's opaque reference. It never sees the payment's
// own reference (an invoice number of the product side), who entered a row, or
// another partner's anything.

import { prisma } from '@/lib/prisma';
import { affiliateRowScope } from '@/lib/affiliateContractRule';
import { COMMISSION_STATUSES, listCommissions, type CommissionStatus } from '@/lib/affiliateCommissions';
import { parseCommissionPlan } from '@/lib/affiliateCommissionRule';
import { planTermsView } from '@/lib/affiliatePlanTerms';
import { listPayouts } from '@/lib/affiliatePayouts';
import { referralLink } from '@/lib/affiliateReferralRule';
import type { GatedPartner } from '@/lib/affiliateContract';

export const PORTAL_CUSTOMERS_PER_PAGE = 50;

function scopeOf(partner: GatedPartner) {
  const scope = affiliateRowScope({ role: 'AFFILIATE', orgId: partner.orgId, partnerId: partner.id });
  // AFFILIATE with a partner always has a scope; the check keeps a future change honest.
  if (!scope?.partnerId) throw new Error('affiliate scope without a partner');
  return { orgId: scope.orgId, partnerId: scope.partnerId };
}

const boundedPage = (raw: unknown) => {
  const n = Math.floor(Number(raw ?? 1));
  return Number.isFinite(n) ? Math.min(10_000, Math.max(1, n)) : 1;
};

export async function partnerSummary(partner: GatedPartner) {
  const scope = scopeOf(partner);
  const [settings, row, customers, sums] = await Promise.all([
    prisma.affiliateProgramSettings.findUnique({ where: { orgId: scope.orgId }, select: { referralUrl: true } }),
    prisma.affiliatePartner.findFirst({ where: { id: scope.partnerId, orgId: scope.orgId }, select: { noticeEffectiveAt: true } }),
    prisma.affiliateCustomer.count({ where: scope }),
    prisma.affiliateCommission.groupBy({ by: ['status'], where: scope, _count: { _all: true }, _sum: { amountMinor: true } }),
  ]);
  const totals = Object.fromEntries(
    COMMISSION_STATUSES.map((s) => {
      const g = sums.find((x) => x.status === s);
      return [s, { count: g?._count._all ?? 0, amountMinor: g?._sum.amountMinor ?? 0 }];
    }),
  ) as Record<CommissionStatus, { count: number; amountMinor: number }>;
  return {
    code: partner.code,
    status: partner.status,
    noticeEffectiveAt: row?.noticeEffectiveAt?.toISOString() ?? null,
    link: referralLink(settings?.referralUrl, partner.code),
    customers,
    totals,
  };
}

/**
 * The organisation's current commission plan, read-only (#3349). The org is the
 * signed-in partner's own (from the session, never the request), so a partner reads
 * its own programme's plan and nobody else's. The plan holds only terms the partner
 * is meant to know; `plan` is null while none is saved (or a stored one no longer parses).
 */
export async function partnerPlanTerms(partner: GatedPartner) {
  const scope = scopeOf(partner);
  const settings = await prisma.affiliateProgramSettings.findUnique({
    where: { orgId: scope.orgId },
    select: { plan: true, planVersion: true, planEffectiveAt: true },
  });
  const parsed = settings?.plan ? parseCommissionPlan(settings.plan) : null;
  if (!settings || !parsed?.ok) return { terms: null, planVersion: 0, effectiveAt: null };
  return {
    terms: planTermsView(parsed.plan),
    planVersion: settings.planVersion,
    effectiveAt: settings.planEffectiveAt?.toISOString() ?? null,
  };
}

export async function partnerCustomers(partner: GatedPartner, rawPage?: unknown) {
  const scope = scopeOf(partner);
  const page = boundedPage(rawPage);
  const [rows, total] = await Promise.all([
    prisma.affiliateCustomer.findMany({
      where: scope,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PORTAL_CUSTOMERS_PER_PAGE,
      take: PORTAL_CUSTOMERS_PER_PAGE,
      select: { id: true, externalRef: true, createdAt: true, _count: { select: { payments: true } } },
    }),
    prisma.affiliateCustomer.count({ where: scope }),
  ]);
  const ids = rows.map((r) => r.id);
  // Earned per customer (everything but REJECTED), and the first payment day —
  // the customer's "since", whether it was entered by hand (createdAt is the
  // moment of entry, possibly back-dated) or imported — summed in SQL for this page.
  const [earned, first] = ids.length
    ? await Promise.all([
        prisma.affiliateCommission.groupBy({
          by: ['customerId'],
          where: { ...scope, customerId: { in: ids }, status: { not: 'REJECTED' } },
          _sum: { amountMinor: true },
        }),
        prisma.affiliatePayment.groupBy({ by: ['customerId'], where: { orgId: scope.orgId, customerId: { in: ids } }, _min: { receivedAt: true } }),
      ])
    : [[], []];
  const earnedBy = new Map(earned.map((e) => [e.customerId, e._sum.amountMinor ?? 0]));
  const firstBy = new Map(first.map((f) => [f.customerId, f._min.receivedAt]));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      ref: r.externalRef,
      since: (firstBy.get(r.id) ?? r.createdAt).toISOString(),
      payments: r._count.payments,
      earnedMinor: earnedBy.get(r.id) ?? 0,
    })),
    total,
    page,
    perPage: PORTAL_CUSTOMERS_PER_PAGE,
  };
}

export async function partnerCommissions(partner: GatedPartner, opts: { status?: unknown; page?: unknown } = {}) {
  const scope = scopeOf(partner);
  const status = (COMMISSION_STATUSES as readonly unknown[]).includes(opts.status) ? (opts.status as CommissionStatus) : null;
  const result = await listCommissions(scope.orgId, { partnerId: scope.partnerId, status, page: boundedPage(opts.page) });
  return {
    ...result,
    status,
    // The partner's view of a row: no partner block, no payment reference.
    rows: result.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      // 0 = a commission imported from a previous system (no plan computed it).
      planVersion: r.planVersion,
      amountMinor: r.amountMinor,
      currency: r.currency,
      status: r.status,
      accruedAt: r.accruedAt,
      dueAt: r.dueAt,
      paidAt: r.paidAt,
      customerRef: r.customerRef,
      paymentAmountMinor: r.payment.amountMinor,
    })),
  };
}

export async function partnerPayouts(partner: GatedPartner, rawPage?: unknown) {
  const scope = scopeOf(partner);
  const result = await listPayouts(scope.orgId, { partnerId: scope.partnerId, page: boundedPage(rawPage) });
  return { ...result, rows: result.rows.map(({ partner: _partner, ...r }) => r) };
}

/** One payout with its commissions; null when it is not this partner's (the page answers 404). */
export async function partnerPayout(partner: GatedPartner, payoutId: string) {
  const scope = scopeOf(partner);
  const payout = await prisma.affiliatePayout.findFirst({
    where: { id: payoutId, ...scope },
    select: {
      id: true,
      amountMinor: true,
      currency: true,
      paidAt: true,
      reference: true,
      commissions: {
        orderBy: [{ accruedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, amountMinor: true, currency: true, accruedAt: true, customer: { select: { externalRef: true } } },
      },
    },
  });
  if (!payout) return null;
  return {
    id: payout.id,
    amountMinor: payout.amountMinor,
    currency: payout.currency,
    paidAt: payout.paidAt.toISOString(),
    reference: payout.reference,
    commissions: payout.commissions.map((c) => ({
      id: c.id,
      amountMinor: c.amountMinor,
      currency: c.currency,
      accruedAt: c.accruedAt.toISOString(),
      customerRef: c.customer.externalRef,
    })),
  };
}
