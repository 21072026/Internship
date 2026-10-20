// The one writer for affiliate payments and commissions (docs/affiliate-module.md).
//
// Manual entry today and the marketing product's API later both call this, so
// there is exactly one path that creates an AffiliatePayment or an
// AffiliateCommission. Callers run it inside prisma.$transaction().
//
// The facts are read under the partner's row lock, so two payments for the same
// partner cannot both see the same paying-customer count. The arithmetic is
// src/lib/affiliatePaymentPlan.ts; this file only reads, applies and reports.

import type { AffiliatePaymentSource, Prisma } from '@prisma/client';
import { CONTRACT } from '@/lib/affiliateCommissionRule';
import { AffiliatePaymentError, planAffiliatePayment, type NoneReason } from '@/lib/affiliatePaymentPlan';

export interface RecordPaymentInput {
  orgId: string;
  partnerId: string;
  /** The customer's id on the marketing product's side. */
  externalCustomerRef: string;
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  /** The idempotency key. Required for manual entries too. */
  externalPaymentRef: string;
  source: AffiliatePaymentSource;
  enteredById: string | null;
}

export type RecordPaymentResult =
  | { status: 'DUPLICATE' }
  | {
      status: 'RECORDED';
      paymentId: string;
      commissionId: string | null;
      /** Why no commission was written; null when one was. */
      noneReason: NoneReason | null;
    };

export async function recordAffiliatePayment(
  tx: Prisma.TransactionClient,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  // Serialize every payment for this partner. Without the lock two concurrent
  // first payments could both be given the same paying-customer ordinal.
  await tx.$queryRaw`SELECT id FROM \`AffiliatePartner\` WHERE id = ${input.partnerId} FOR UPDATE`;

  const partner = await tx.affiliatePartner.findFirst({
    where: { id: input.partnerId, orgId: input.orgId },
    select: { id: true, noticeEffectiveAt: true },
  });
  if (!partner) {
    throw new AffiliatePaymentError('PARTNER_NOT_FOUND', 'no partner with that id in this organisation');
  }

  const found = await tx.affiliateCustomer.findFirst({
    where: { orgId: input.orgId, externalRef: input.externalCustomerRef },
    select: { id: true, partnerId: true, firstPaymentAt: true, payingCustomerOrdinal: true },
  });
  if (found && found.partnerId !== partner.id) {
    throw new AffiliatePaymentError(
      'CUSTOMER_OF_ANOTHER_PARTNER',
      'this customer is already referred by another partner',
    );
  }
  const customer =
    found ??
    (await tx.affiliateCustomer.create({
      data: { orgId: input.orgId, partnerId: partner.id, externalRef: input.externalCustomerRef },
      select: { id: true, partnerId: true, firstPaymentAt: true, payingCustomerOrdinal: true },
    }));

  const existing = await tx.affiliatePayment.findUnique({
    where: {
      customerId_externalPaymentRef: { customerId: customer.id, externalPaymentRef: input.externalPaymentRef },
    },
    select: { id: true },
  });

  const otherPayingCustomers = await tx.affiliateCustomer.count({
    where: {
      orgId: input.orgId,
      partnerId: partner.id,
      firstPaymentAt: { not: null },
      NOT: { id: customer.id },
    },
  });

  // The switch happens when the tenth paying customer first pays.
  const tenth = await tx.affiliateCustomer.findFirst({
    where: { orgId: input.orgId, partnerId: partner.id, payingCustomerOrdinal: CONTRACT.switchCustomerCount },
    select: { firstPaymentAt: true },
  });

  const plan = planAffiliatePayment({
    amountMinor: input.amountMinor,
    currency: input.currency,
    receivedAt: input.receivedAt,
    externalPaymentRef: input.externalPaymentRef,
    customer: { firstPaymentAt: customer.firstPaymentAt, payingCustomerOrdinal: customer.payingCustomerOrdinal },
    otherPayingCustomers,
    switchedAt: tenth?.firstPaymentAt ?? null,
    noticeEffectiveAt: partner.noticeEffectiveAt,
    alreadyRecorded: existing !== null,
  });

  if (plan.kind === 'DUPLICATE') return { status: 'DUPLICATE' };

  const payment = await tx.affiliatePayment.create({
    data: {
      orgId: input.orgId,
      customerId: customer.id,
      amountMinor: input.amountMinor,
      currency: input.currency,
      receivedAt: input.receivedAt,
      source: input.source,
      externalPaymentRef: input.externalPaymentRef,
      enteredById: input.enteredById,
    },
    select: { id: true },
  });

  if (plan.customerFirstPayment) {
    await tx.affiliateCustomer.update({ where: { id: customer.id }, data: plan.customerFirstPayment });
  }

  let commissionId: string | null = null;
  if (plan.commission) {
    const commission = await tx.affiliateCommission.create({
      data: {
        orgId: input.orgId,
        partnerId: partner.id,
        customerId: customer.id,
        paymentId: payment.id,
        kind: plan.commission.kind,
        amountMinor: plan.commission.amountMinor,
        currency: input.currency,
        accruedAt: input.receivedAt,
        windowEndsAt: plan.commission.windowEndsAt,
        status: 'PENDING',
      },
      select: { id: true },
    });
    commissionId = commission.id;
  }

  return { status: 'RECORDED', paymentId: payment.id, commissionId, noneReason: plan.noneReason };
}
