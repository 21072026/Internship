// Reading the programme's payments for the admin screen (docs/affiliate-module.md,
// #3116). Writing one is recordAffiliatePayment() in src/lib/affiliatePaymentWriter.ts
// — never here.

import { prisma } from '@/lib/prisma';

export const PAYMENTS_PER_PAGE = 50;

export interface PaymentRow {
  id: string;
  receivedAt: string;
  amountMinor: number;
  currency: string;
  externalPaymentRef: string;
  source: 'MANUAL' | 'API';
  customerRef: string;
  partner: { id: string; code: string; displayName: string };
  commission: { kind: 'TIER' | 'PERCENT'; amountMinor: number; status: string; planVersion: number } | null;
}

/** Newest received first; one page, plus the total for the pager. */
export async function listPayments(orgId: string, opts: { partnerId?: string | null; page?: number } = {}): Promise<{ rows: PaymentRow[]; total: number; page: number; perPage: number }> {
  // Bounded: a huge or non-finite page would overflow Prisma's `skip`.
  const raw = Math.floor(opts.page ?? 1);
  const page = Number.isFinite(raw) ? Math.min(10_000, Math.max(1, raw)) : 1;
  const where = { orgId, ...(opts.partnerId ? { customer: { partnerId: opts.partnerId } } : {}) };
  const [rows, total] = await Promise.all([
    prisma.affiliatePayment.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * PAYMENTS_PER_PAGE,
      take: PAYMENTS_PER_PAGE,
      select: {
        id: true,
        receivedAt: true,
        amountMinor: true,
        currency: true,
        externalPaymentRef: true,
        source: true,
        customer: { select: { externalRef: true, partner: { select: { id: true, code: true, displayName: true } } } },
        commission: { select: { kind: true, amountMinor: true, status: true, planVersion: true } },
      },
    }),
    prisma.affiliatePayment.count({ where }),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      receivedAt: r.receivedAt.toISOString(),
      amountMinor: r.amountMinor,
      currency: r.currency,
      externalPaymentRef: r.externalPaymentRef,
      source: r.source,
      customerRef: r.customer.externalRef,
      partner: r.customer.partner,
      commission: r.commission,
    })),
    total,
    page,
    perPage: PAYMENTS_PER_PAGE,
  };
}
