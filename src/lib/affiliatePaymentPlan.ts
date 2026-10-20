// The planning half of recording a payment from a referred customer.
//
// PURE: it takes the facts the writer read inside the partner's row lock and
// returns exactly which rows to create or update. It decides nothing about the
// database. The writer (src/lib/affiliatePaymentWriter.ts) is the only code that
// applies the plan, and it is the only code that creates payments or commissions.
//
// The commission amount itself comes from src/lib/affiliateCommissionRule.ts.
// This file only decides WHICH facts go into that rule and what gets written.

import { decideCommission, windowEndsAt, type NoneReason } from '@/lib/affiliateCommissionRule';

export type { NoneReason };

/** The contract is priced in euro. Anything else is refused, not converted. */
const CONTRACT_CURRENCY = 'EUR';

export class AffiliatePaymentError extends Error {
  readonly code: AffiliatePaymentErrorCode;
  constructor(code: AffiliatePaymentErrorCode, message: string) {
    super(message);
    this.name = 'AffiliatePaymentError';
    this.code = code;
  }
}

export type AffiliatePaymentErrorCode =
  | 'INVALID_AMOUNT'
  | 'UNSUPPORTED_CURRENCY'
  | 'MISSING_REFERENCE'
  | 'PAYMENT_BEFORE_FIRST_PAYMENT'
  | 'PARTNER_NOT_FOUND'
  | 'CUSTOMER_OF_ANOTHER_PARTNER';

export interface PlanInput {
  /** Cents. Must be a positive integer. */
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  /** Required for every payment, manual or API: it is the idempotency key. */
  externalPaymentRef: string;
  /** The referred customer as the writer found it. */
  customer: {
    firstPaymentAt: Date | null;
    /** Null until the first payment. */
    payingCustomerOrdinal: number | null;
  };
  /**
   * How many of this partner's other customers have already paid for the
   * first time. The new customer is not counted, even when it is the first payment.
   */
  otherPayingCustomers: number;
  /** When the partner's tenth paying customer first paid. Null before the switch. */
  switchedAt: Date | null;
  noticeEffectiveAt: Date | null;
  /** True when a payment with the same (customer, externalPaymentRef) already exists. */
  alreadyRecorded: boolean;
}

export type PaymentPlan =
  | { kind: 'DUPLICATE' }
  | {
      kind: 'RECORD';
      /** Set only for a first payment: the customer's new paying facts. */
      customerFirstPayment: {
        firstPaymentAt: Date;
        firstPaymentMinor: number;
        payingCustomerOrdinal: number;
      } | null;
      /** Null when the payment earns nothing; the reason is kept for the audit trail. */
      commission:
        | { kind: 'TIER' | 'PERCENT'; amountMinor: number; windowEndsAt: Date | null }
        | null;
      noneReason: NoneReason | null;
    };

/**
 * Turn one incoming payment into the writes the writer must apply.
 *
 * Throws AffiliatePaymentError for input that must never reach the database:
 * a non-positive or non-integer amount, a currency other than the contract's,
 * a missing reference, or a non-first payment dated before the customer's first.
 */
export function planAffiliatePayment(input: PlanInput): PaymentPlan {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AffiliatePaymentError('INVALID_AMOUNT', 'amount must be a positive whole number of cents');
  }
  if (input.currency !== CONTRACT_CURRENCY) {
    throw new AffiliatePaymentError('UNSUPPORTED_CURRENCY', `only ${CONTRACT_CURRENCY} is supported`);
  }
  if (input.externalPaymentRef.trim() === '') {
    throw new AffiliatePaymentError('MISSING_REFERENCE', 'every payment needs an external reference');
  }
  if (input.alreadyRecorded) return { kind: 'DUPLICATE' };

  const isFirstPayment = input.customer.firstPaymentAt === null;
  if (
    !isFirstPayment &&
    input.receivedAt.getTime() < (input.customer.firstPaymentAt as Date).getTime()
  ) {
    throw new AffiliatePaymentError(
      'PAYMENT_BEFORE_FIRST_PAYMENT',
      'a payment cannot be dated before the customer\'s first payment',
    );
  }

  const ordinal = isFirstPayment ? input.otherPayingCustomers + 1 : (input.customer.payingCustomerOrdinal ?? 0);
  const customerFirstPaymentAt = isFirstPayment ? input.receivedAt : (input.customer.firstPaymentAt as Date);

  const decision = decideCommission({
    paymentMinor: input.amountMinor,
    receivedAt: input.receivedAt,
    isFirstPayment,
    payingCustomerOrdinal: ordinal,
    customerFirstPaymentAt,
    switchedAt: input.switchedAt,
    noticeEffectiveAt: input.noticeEffectiveAt,
  });

  if (decision.kind === 'NONE') {
    return {
      kind: 'RECORD',
      customerFirstPayment: isFirstPayment ? firstPaymentFacts(input, ordinal) : null,
      commission: null,
      noneReason: decision.reason,
    };
  }

  return {
    kind: 'RECORD',
    customerFirstPayment: isFirstPayment ? firstPaymentFacts(input, ordinal) : null,
    commission: {
      kind: decision.kind,
      amountMinor: decision.amountMinor,
      windowEndsAt: decision.kind === 'PERCENT' ? windowEndsAt(customerFirstPaymentAt) : null,
    },
    noneReason: null,
  };
}

function firstPaymentFacts(input: PlanInput, ordinal: number) {
  return {
    firstPaymentAt: input.receivedAt,
    firstPaymentMinor: input.amountMinor,
    payingCustomerOrdinal: ordinal,
  };
}
