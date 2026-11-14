// Reading the programme's commissions for the admin screen (docs/affiliate-module.md,
// #3116). Every write is in src/lib/affiliatePaymentWriter.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { commissionOrderBy, listDateRange, type ListQuery } from '@/lib/affiliateListQueryRule';

export const COMMISSIONS_PER_PAGE = 50;
export const COMMISSION_STATUSES = ['PENDING', 'APPROVED', 'PAID', 'REJECTED'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export interface CommissionRow {
  id: string;
  kind: 'TIER' | 'PERCENT' | 'IMPORTED';
  amountMinor: number;
  currency: string;
  status: CommissionStatus;
  accruedAt: string;
  dueAt: string;
  planVersion: number;
  partner: { id: string; code: string; displayName: string };
  customerRef: string;
  /** The admin-written label the partner sees (#3352); null when none. */
  customerLabel: string | null;
  payment: { amountMinor: number; externalPaymentRef: string };
  paidAt: string | null;
}

export async function listCommissions(
  orgId: string,
  opts: {
    status?: CommissionStatus | null;
    partnerId?: string | null;
    page?: number;
    /** The admin list's filters and sort (#3539, src/lib/affiliateListQueryRule.ts). */
    kind?: CommissionRow['kind'] | null;
    from?: string | null;
    to?: string | null;
    sort?: ListQuery['sort'];
    dir?: ListQuery['dir'];
  } = {},
): Promise<{ rows: CommissionRow[]; total: number; page: number; perPage: number; totals: Record<CommissionStatus, { count: number; amountMinor: number }> }> {
  // Bounded: a huge or non-finite page would overflow Prisma's `skip`.
  const raw = Math.floor(opts.page ?? 1);
  const page = Number.isFinite(raw) ? Math.min(10_000, Math.max(1, raw)) : 1;
  const dueAt = listDateRange({ from: opts.from ?? null, to: opts.to ?? null });
  // Every filter but the status: the totals per status are those of the filtered list.
  const scope = {
    orgId,
    ...(opts.partnerId ? { partnerId: opts.partnerId } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(dueAt ? { dueAt } : {}),
  };
  const where = { ...scope, ...(opts.status ? { status: opts.status } : {}) };
  const [rows, total, sums] = await Promise.all([
    prisma.affiliateCommission.findMany({
      where,
      // Default: oldest due first, the order a payer works through them.
      // Built from the rule's constant table; the cast only names Prisma's type.
      orderBy: commissionOrderBy({ sort: opts.sort ?? 'due', dir: opts.dir ?? 'asc' }) as Prisma.AffiliateCommissionOrderByWithRelationInput[],
      skip: (page - 1) * COMMISSIONS_PER_PAGE,
      take: COMMISSIONS_PER_PAGE,
      select: {
        id: true,
        kind: true,
        amountMinor: true,
        currency: true,
        status: true,
        accruedAt: true,
        dueAt: true,
        planVersion: true,
        paidAt: true,
        partner: { select: { id: true, code: true, displayName: true } },
        customer: { select: { externalRef: true, partnerLabel: true } },
        payment: { select: { amountMinor: true, externalPaymentRef: true } },
      },
    }),
    prisma.affiliateCommission.count({ where }),
    prisma.affiliateCommission.groupBy({ by: ['status'], where: scope, _count: { _all: true }, _sum: { amountMinor: true } }),
  ]);
  const totals = Object.fromEntries(
    COMMISSION_STATUSES.map((s) => {
      const g = sums.find((x) => x.status === s);
      return [s, { count: g?._count._all ?? 0, amountMinor: g?._sum.amountMinor ?? 0 }];
    }),
  ) as Record<CommissionStatus, { count: number; amountMinor: number }>;
  return {
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountMinor: r.amountMinor,
      currency: r.currency,
      status: r.status,
      accruedAt: r.accruedAt.toISOString(),
      dueAt: r.dueAt.toISOString(),
      planVersion: r.planVersion,
      partner: r.partner,
      customerRef: r.customer.externalRef,
      customerLabel: r.customer.partnerLabel,
      payment: r.payment,
      paidAt: r.paidAt?.toISOString() ?? null,
    })),
    total,
    page,
    perPage: COMMISSIONS_PER_PAGE,
    totals,
  };
}

/**
 * What a payout can take for one partner: its APPROVED commissions, oldest due
 * first, up to MAX (the writer's per-payout limit) — and the totals of ALL of
 * them, so a screen can say when it shows fewer than there are. The amount a
 * payer transfers must be the sum of the rows they actually select.
 */
export async function approvedForPayout(orgId: string, partnerId: string, max: number) {
  const where = { orgId, partnerId, status: 'APPROVED' as const };
  const [rows, all] = await Promise.all([
    prisma.affiliateCommission.findMany({
      where,
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: max,
      select: {
        id: true,
        amountMinor: true,
        currency: true,
        dueAt: true,
        customer: { select: { externalRef: true, partnerLabel: true } },
        payment: { select: { externalPaymentRef: true } },
      },
    }),
    prisma.affiliateCommission.aggregate({ where, _count: { _all: true }, _sum: { amountMinor: true } }),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      amountMinor: r.amountMinor,
      currency: r.currency,
      dueAt: r.dueAt.toISOString(),
      customerRef: r.customer.externalRef,
      customerLabel: r.customer.partnerLabel,
      payment: { externalPaymentRef: r.payment.externalPaymentRef },
    })),
    totalCount: all._count._all,
    totalAmountMinor: all._sum.amountMinor ?? 0,
  };
}
