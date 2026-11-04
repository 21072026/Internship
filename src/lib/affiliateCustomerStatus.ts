// Per-partner customer status counts (docs/affiliate-module.md, "Customer status",
// #3542) — the ONE query the partner portal (#3543) and the admin screens (#3544)
// read the funnel from. The rule is src/lib/affiliateCustomerStatusRule.ts.
//
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

/**
 * Status counts per partner of `orgId`. `partnerIds` narrows to those partners
 * (the portal passes its own one); omitted, every partner with a customer is
 * counted. A requested partner without customers answers all zeros.
 */
export async function partnerCustomerStatusCounts(
  orgId: string,
  options: { partnerIds?: string[]; now?: Date } = {},
  db: Pick<typeof prisma, 'affiliateProgramSettings' | 'affiliateCustomer' | 'affiliatePayment'> = prisma,
): Promise<Map<string, CustomerStatusCounts>> {
  const now = options.now ?? new Date();
  const partnerFilter = options.partnerIds ? { partnerId: { in: options.partnerIds } } : {};
  const result = new Map<string, CustomerStatusCounts>();
  for (const id of options.partnerIds ?? []) result.set(id, emptyStatusCounts());
  if (options.partnerIds && options.partnerIds.length === 0) return result;

  const [settingsRow, customers, lastPayments] = await Promise.all([
    db.affiliateProgramSettings.findUnique({ where: { orgId }, select: { freeMonths: true, passiveAfterDays: true } }),
    db.affiliateCustomer.findMany({ where: { orgId, ...partnerFilter }, select: { id: true, partnerId: true, createdAt: true, endedAt: true } }),
    db.affiliatePayment.groupBy({ by: ['customerId'], where: { orgId, customer: partnerFilter }, _max: { receivedAt: true } }),
  ]);
  const settings = storedCustomerStatusSettings(settingsRow);
  const lastPaid = new Map(lastPayments.map((p) => [p.customerId, p._max.receivedAt ?? null]));

  for (const c of customers) {
    const status = customerStatus({ registeredAt: c.createdAt, lastPaymentAt: lastPaid.get(c.id) ?? null, endedAt: c.endedAt, now, settings });
    const counts = result.get(c.partnerId) ?? emptyStatusCounts();
    counts[status] += 1;
    result.set(c.partnerId, counts);
  }
  return result;
}
