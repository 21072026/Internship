// Reading the programme's payouts for the admin screen (docs/affiliate-module.md,
// #3116). Recording one is createPayout() in src/lib/affiliatePaymentWriter.ts.

import { prisma } from '@/lib/prisma';

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

/** Newest transfer first, paged. */
export async function listPayouts(orgId: string, opts: { partnerId?: string | null; page?: number } = {}): Promise<{ rows: PayoutRow[]; total: number; page: number; perPage: number }> {
  // Bounded: a huge or non-finite page would overflow Prisma's `skip`.
  const raw = Math.floor(opts.page ?? 1);
  const page = Number.isFinite(raw) ? Math.min(10_000, Math.max(1, raw)) : 1;
  const where = { orgId, ...(opts.partnerId ? { partnerId: opts.partnerId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.affiliatePayout.findMany({
      where,
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
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
