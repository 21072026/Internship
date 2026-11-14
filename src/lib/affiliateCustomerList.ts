// The admin's customer list (docs/affiliate-module.md § Customers, #3538): one
// row per referred customer of the org — its partner, first and last payment,
// how many payments, the end of its commission window and the commission it
// earned. Read-only; the customer's label is still edited from the payments screen.
//
// Every query carries `orgId` explicitly; a partner id of another org lists
// nothing (the route answers that as 404). A FIXED number of queries per page:
// the page of customers, the count, the payment span, the commission sum, and the
// windows of the page's partners (src/lib/affiliateCustomerWindows.ts — the
// engine's own value, never a second calculation).

import { prisma } from '@/lib/prisma';
import { customerWindowsByPartner, windowView, type WindowView } from '@/lib/affiliateCustomerWindows';

export const ADMIN_CUSTOMERS_PER_PAGE = 50;

export interface AdminCustomerRow {
  id: string;
  ref: string;
  label: string | null;
  partner: { id: string; code: string; displayName: string };
  firstPaymentAt: string | null;
  lastPaymentAt: string | null;
  payments: number;
  window: WindowView;
  /** Everything but REJECTED, in minor units of the programme's currency. */
  earnedMinor: number;
}

export async function listAdminCustomers(
  orgId: string,
  opts: { partnerId?: string | null; page?: number } = {},
): Promise<{ rows: AdminCustomerRow[]; total: number; page: number; perPage: number; showWindow: boolean }> {
  // Bounded: a huge or non-finite page would overflow Prisma's `skip`.
  const raw = Math.floor(opts.page ?? 1);
  const page = Number.isFinite(raw) ? Math.min(10_000, Math.max(1, raw)) : 1;
  const where = { orgId, ...(opts.partnerId ? { partnerId: opts.partnerId } : {}) };
  const [customers, total] = await Promise.all([
    prisma.affiliateCustomer.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * ADMIN_CUSTOMERS_PER_PAGE,
      take: ADMIN_CUSTOMERS_PER_PAGE,
      select: {
        id: true,
        externalRef: true,
        partnerLabel: true,
        partner: { select: { id: true, code: true, displayName: true } },
        _count: { select: { payments: true } },
      },
    }),
    prisma.affiliateCustomer.count({ where }),
  ]);
  const ids = customers.map((c) => c.id);
  const partnerIds = [...new Set(customers.map((c) => c.partner.id))];
  const [span, earned, windows] = ids.length
    ? await Promise.all([
        prisma.affiliatePayment.groupBy({ by: ['customerId'], where: { orgId, customerId: { in: ids } }, _min: { receivedAt: true }, _max: { receivedAt: true } }),
        prisma.affiliateCommission.groupBy({ by: ['customerId'], where: { orgId, customerId: { in: ids }, status: { not: 'REJECTED' } }, _sum: { amountMinor: true } }),
        customerWindowsByPartner(orgId, partnerIds),
      ])
    : [[], [], null];
  const spanBy = new Map(span.map((s) => [s.customerId, s]));
  const earnedBy = new Map(earned.map((e) => [e.customerId, e._sum.amountMinor ?? 0]));
  return {
    rows: customers.map((c) => {
      const s = spanBy.get(c.id);
      return {
        id: c.id,
        ref: c.externalRef,
        label: c.partnerLabel,
        partner: c.partner,
        firstPaymentAt: s?._min.receivedAt?.toISOString() ?? null,
        lastPaymentAt: s?._max.receivedAt?.toISOString() ?? null,
        payments: c._count.payments,
        window: windowView(windows?.partners.get(c.partner.id)?.windows.get(c.id)),
        earnedMinor: earnedBy.get(c.id) ?? 0,
      };
    }),
    total,
    page,
    perPage: ADMIN_CUSTOMERS_PER_PAGE,
    // Without a percent phase there is no window to show (an empty page shows no table).
    showWindow: windows !== null && windows.plan !== null,
  };
}
