// Reading the programme's payouts for the admin screen (docs/affiliate-module.md,
// #3116). Recording one is createPayout() in src/lib/affiliatePaymentWriter.ts.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { listDateRange, payoutOrderBy, type ListQuery } from '@/lib/affiliateListQueryRule';

export const PAYOUTS_PER_PAGE = 50;

export interface PayoutRow {
  id: string;
  partner: { id: string; code: string; displayName: string };
  amountMinor: number;
  currency: string;
  paidAt: string;
  reference: string | null;
  commissions: number;
}

/** Newest transfer first by default, paged. `q` finds the transfer reference (#3539). */
export async function listPayouts(
  orgId: string,
  opts: { partnerId?: string | null; page?: number; q?: string | null; from?: string | null; to?: string | null; sort?: ListQuery['sort']; dir?: ListQuery['dir'] } = {},
): Promise<{ rows: PayoutRow[]; total: number; page: number; perPage: number }> {
  // Bounded: a huge or non-finite page would overflow Prisma's `skip`.
  const raw = Math.floor(opts.page ?? 1);
  const page = Number.isFinite(raw) ? Math.min(10_000, Math.max(1, raw)) : 1;
  const paidAt = listDateRange({ from: opts.from ?? null, to: opts.to ?? null });
  const where = {
    orgId,
    ...(opts.partnerId ? { partnerId: opts.partnerId } : {}),
    ...(paidAt ? { paidAt } : {}),
    ...(opts.q ? { reference: { contains: opts.q } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.affiliatePayout.findMany({
      where,
      // Built from the rule's constant table; the cast only names Prisma's type.
      orderBy: payoutOrderBy({ sort: opts.sort ?? 'date', dir: opts.dir ?? 'desc' }) as Prisma.AffiliatePayoutOrderByWithRelationInput[],
      skip: (page - 1) * PAYOUTS_PER_PAGE,
      take: PAYOUTS_PER_PAGE,
      select: {
        id: true,
        amountMinor: true,
        currency: true,
        paidAt: true,
        reference: true,
        partner: { select: { id: true, code: true, displayName: true } },
        _count: { select: { commissions: true } },
      },
    }),
    prisma.affiliatePayout.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      partner: r.partner,
      amountMinor: r.amountMinor,
      currency: r.currency,
      paidAt: r.paidAt.toISOString(),
      reference: r.reference,
      commissions: r._count.commissions,
    })),
    total,
    page,
    perPage: PAYOUTS_PER_PAGE,
  };
}
