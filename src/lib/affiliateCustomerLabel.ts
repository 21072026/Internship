// Writing a customer's partner-facing label (#3352). Server-only. The one writer
// of `AffiliateCustomer.partnerLabel`; nothing that ingests data (account
// events, API payments, the migration) touches it.

import { prisma } from '@/lib/prisma';

/** False when the customer is not this organisation's (the route answers 404). */
export async function setCustomerLabel(orgId: string, customerId: string, label: string | null, actorId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.affiliateCustomer.findFirst({ where: { id: customerId, orgId }, select: { partnerLabel: true } });
    if (!current) return false;
    if (current.partnerLabel === label) return true;
    await tx.affiliateCustomer.updateMany({ where: { id: customerId, orgId }, data: { partnerLabel: label } });
    // The label itself is not repeated in the audit row: whether it was set or
    // cleared is what the trail needs.
    await tx.auditLog.create({
      data: { orgId, actorId, action: 'affiliate.customer.label', targetId: customerId, detail: JSON.stringify({ label: label === null ? 'cleared' : 'set' }) },
    });
    return true;
  });
}
