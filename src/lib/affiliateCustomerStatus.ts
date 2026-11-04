// Per-partner customer status counts (docs/affiliate-module.md, "Customer status",
// #3542) — the ONE query the partner portal (#3543) and the admin screens (#3544)
// read the funnel from. The rule is src/lib/affiliateCustomerStatusRule.ts.
//
// The per-customer list (`partnerCustomerStatuses`) is the base; the counts fold it.
// A FIXED number of queries whatever the programme's size: the settings row, the
// customers' registration and end, and the newest payment per customer as one
// `groupBy`. The status itself is judged here, in memory, by the pure rule — a
// SQL copy of it would be a second rule to keep in step. Every query carries
// `orgId` explicitly; a partner id of another org counts nothing.

import { prisma } from '@/lib/prisma';
import {
  customerStatus,
  emptyStatusCounts,
  storedCustomerStatusSettings,
  type CustomerStatus,
} from '@/lib/affiliateCustomerStatusRule';

export type CustomerStatusCounts = Record<CustomerStatus, number>;

type StatusDb = Pick<typeof prisma, 'affiliateProgramSettings' | 'affiliateCustomer' | 'affiliatePayment'>;

export interface StatusQueryOptions {
  /** Narrow to these partners; omitted, every partner of the org. */
  partnerIds?: string[];
  /** Only customers registered at or after this instant (a funnel period, #3543). */
  registeredFrom?: Date | null;
  now?: Date;
}

/**
 * Every matching customer of `orgId` with its status, newest registration first.
 * The counts below fold this list, so a list filtered by status (the portal's
 * customer list, #3543) and the counts can never disagree.
 */
export async function partnerCustomerStatuses(
  orgId: string,
  options: StatusQueryOptions = {},
  db: StatusDb = prisma,
): Promise<{ id: string; partnerId: string; createdAt: Date; status: CustomerStatus }[]> {
  if (options.partnerIds && options.partnerIds.length === 0) return [];
  const now = options.now ?? new Date();
  const partnerFilter = options.partnerIds ? { partnerId: { in: options.partnerIds } } : {};
  const registered = options.registeredFrom ? { createdAt: { gte: options.registeredFrom } } : {};
  const customerWhere = { ...partnerFilter, ...registered };

  const [settingsRow, customers, lastPayments] = await Promise.all([
    db.affiliateProgramSettings.findUnique({ where: { orgId }, select: { freeMonths: true, passiveAfterDays: true } }),
    db.affiliateCustomer.findMany({
      where: { orgId, ...customerWhere },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, partnerId: true, createdAt: true, endedAt: true },
    }),
    db.affiliatePayment.groupBy({ by: ['customerId'], where: { orgId, customer: customerWhere }, _max: { receivedAt: true } }),
  ]);
  const settings = storedCustomerStatusSettings(settingsRow);
  const lastPaid = new Map(lastPayments.map((p) => [p.customerId, p._max.receivedAt ?? null]));
  return customers.map((c) => ({
    id: c.id,
    partnerId: c.partnerId,
    createdAt: c.createdAt,
    status: customerStatus({ registeredAt: c.createdAt, lastPaymentAt: lastPaid.get(c.id) ?? null, endedAt: c.endedAt, now, settings }),
  }));
}

/**
 * Status counts per partner of `orgId`. `partnerIds` narrows to those partners
 * (the portal passes its own one); omitted, every partner with a customer is
 * counted. A requested partner without customers answers all zeros.
 */
export async function partnerCustomerStatusCounts(
  orgId: string,
  options: StatusQueryOptions = {},
  db: StatusDb = prisma,
): Promise<Map<string, CustomerStatusCounts>> {
  const result = new Map<string, CustomerStatusCounts>();
  for (const id of options.partnerIds ?? []) result.set(id, emptyStatusCounts());
  for (const c of await partnerCustomerStatuses(orgId, options, db)) {
    const counts = result.get(c.partnerId) ?? emptyStatusCounts();
    counts[c.status] += 1;
    result.set(c.partnerId, counts);
  }
  return result;
}
