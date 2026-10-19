// The affiliate commission rule, as written in the partner contract (see
// docs/affiliate-module.md, "The contract rules").
//
// PURE: no database, no clock argument hidden inside, no I/O. Every caller
// passes `receivedAt` and the customer/partner facts it knows. The writer
// (src/lib/affiliateCommission.ts, to come) is the only place that reads and
// writes rows; it asks this module what a payment is worth and records the
// answer.
//
// Money is integer minor units (cents of EUR). Never a float.
//
// Two readings of the contract are open and are marked OPEN below. They are
// decided by the business, not by this file, so each one is one constant or
// one branch to change and is pinned by a test.

export const CONTRACT = {
  /** Percent commission on a referred customer's payments, in basis points (20 %). */
  percentBps: 2000,
  /** Percent commission runs this many months from the customer's first payment. */
  windowMonths: 24,
  /** The paying-customer count at which the percent commission starts. */
  switchCustomerCount: 10,
} as const;

/** One-off commission for a customer's first payment, before the switch. */
export const TIER_BANDS = [
  // Upper bound is inclusive, in cents. "Bis zu 20 Euro" = up to and including 20.00.
  { upToMinor: 2000, commissionMinor: 5000 },
  { upToMinor: 5000, commissionMinor: 10000 },
  { upToMinor: 10000, commissionMinor: 15000 },
] as const;

/** Above the last band ("über 100 Euro"). */
export const TIER_TOP_COMMISSION_MINOR = 25000;

export type PaymentDecision =
  | { kind: 'TIER'; amountMinor: number }
  | { kind: 'PERCENT'; amountMinor: number }
  | { kind: 'NONE'; reason: NoneReason };

export type NoneReason =
  | 'NOT_A_PAYMENT'
  | 'BEFORE_SWITCH'
  | 'WINDOW_CLOSED'
  | 'NEW_CUSTOMER_AFTER_NOTICE';

export interface CommissionInput {
  /** The payment amount in cents. Zero or negative is not a payment. */
  paymentMinor: number;
  /** When the payment reached the organisation's books. */
  receivedAt: Date;
  /** True when this is the referred customer's first payment. */
  isFirstPayment: boolean;
  /**
   * Only for a first payment: how many paying customers this partner has
   * including this one (1 for the partner's first paying customer).
   */
  payingCustomerOrdinal: number;
  /** When the referred customer's first payment was received. */
  customerFirstPaymentAt: Date;
  /** When the partner reached the switch count; null before that. */
  switchedAt: Date | null;
  /** When a 30-day termination takes effect; null when the partner is still active. */
  noticeEffectiveAt: Date | null;
}

/**
 * The tier commission for a customer's first monthly payment, in cents.
 *
 * OPEN: a first payment of exactly 0.00 is not a paying customer and is
 * handled by the caller (decideCommission returns NOT_A_PAYMENT). Amounts with
 * cents between two bands (e.g. 20.50) fall into the higher band, because the
 * contract only states whole-euro bounds.
 */
export function tierCommissionMinor(firstPaymentMinor: number): number {
  for (const band of TIER_BANDS) {
    if (firstPaymentMinor <= band.upToMinor) return band.commissionMinor;
  }
  return TIER_TOP_COMMISSION_MINOR;
}

/**
 * 20 % of a payment, in cents, rounded half up. Integer arithmetic only.
 */
export function percentCommissionMinor(paymentMinor: number): number {
  return Math.floor((paymentMinor * CONTRACT.percentBps + 5000) / 10000);
}

/** The instant the 24-month window of a customer closes (exclusive). */
export function windowEndsAt(customerFirstPaymentAt: Date): Date {
  const end = new Date(customerFirstPaymentAt.getTime());
  end.setUTCMonth(end.getUTCMonth() + CONTRACT.windowMonths);
  return end;
}

/**
 * What one payment from a referred customer is worth to the partner.
 *
 * Reading of the contract (OPEN, pinned by tests):
 * - Customers 1..9 (by first payment) get the tier commission on their first
 *   payment only. Their later payments earn nothing before the switch.
 * - The switch happens when the partner's tenth paying customer pays for the
 *   first time. That first payment is paid as a percent commission, not a tier,
 *   because the contract says the percent starts "ab dem zehnten" customer.
 * - From the switch on, every payment from any referred customer earns 20 %,
 *   including those of customers 1..9, but only for payments received after
 *   the switch (not retroactive), and only within 24 months of that customer's
 *   first payment.
 * - After a termination takes effect, no new customer earns anything. Existing
 *   customers keep earning percent until their window closes.
 */
export function decideCommission(input: CommissionInput): PaymentDecision {
  if (!(input.paymentMinor > 0)) {
    return { kind: 'NONE', reason: 'NOT_A_PAYMENT' };
  }

  if (input.isFirstPayment) {
    if (
      input.noticeEffectiveAt !== null &&
      input.receivedAt.getTime() >= input.noticeEffectiveAt.getTime()
    ) {
      return { kind: 'NONE', reason: 'NEW_CUSTOMER_AFTER_NOTICE' };
    }
    if (input.payingCustomerOrdinal < CONTRACT.switchCustomerCount) {
      return {
        kind: 'TIER',
        amountMinor: tierCommissionMinor(input.paymentMinor),
      };
    }
    // The tenth paying customer, or any after it: percent from this payment on.
    return {
      kind: 'PERCENT',
      amountMinor: percentCommissionMinor(input.paymentMinor),
    };
  }

  if (input.switchedAt === null || input.receivedAt.getTime() < input.switchedAt.getTime()) {
    return { kind: 'NONE', reason: 'BEFORE_SWITCH' };
  }
  if (input.receivedAt.getTime() >= windowEndsAt(input.customerFirstPaymentAt).getTime()) {
    return { kind: 'NONE', reason: 'WINDOW_CLOSED' };
  }
  return {
    kind: 'PERCENT',
    amountMinor: percentCommissionMinor(input.paymentMinor),
  };
}
