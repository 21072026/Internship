// Writing a customer's admin-kept fields: the partner-facing label (#3352) and
// the reverse-charge flag (#3843). Server-only. The one writer of
// `AffiliateCustomer.partnerLabel` and `reverseCharge`; nothing that ingests data
// (account events, API payments, the migration) touches them.

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

/**
 * Marks a customer as invoiced without VAT (reverse charge). False when the
 * customer is not this organisation's (the route answers 404). It changes what a
 * transaction count is priced at from now on; stored payments are never repriced.
 */
export async function setCustomerReverseCharge(orgId: string, customerId: string, reverseCharge: boolean, actorId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.affiliateCustomer.findFirst({ where: { id: customerId, orgId }, select: { reverseCharge: true } });
    if (!current) return false;
    if (current.reverseCharge === reverseCharge) return true;
    await tx.affiliateCustomer.updateMany({ where: { id: customerId, orgId }, data: { reverseCharge } });
    await tx.auditLog.create({
      data: { orgId, actorId, action: 'affiliate.customer.reverse_charge', targetId: customerId, detail: JSON.stringify({ reverseCharge }) },
    });
    return true;
  });
}
