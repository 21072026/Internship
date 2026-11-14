// The commission base of an affiliate payment (docs/affiliate-module.md
// § Commission base, #3551/#3552).
//
// A payment's `amountMinor` is the COMMISSION BASE: the undiscounted, gross
// (VAT included) amount for the month's transaction count — never what the
// customer actually paid after a discount. It may arrive in two shapes:
//
//   (a) a breakdown — `transactionCount` × `unitPriceMinor` (the undiscounted
//       gross price per transaction); the base is the product, and the
//       breakdown is stored so the partner can see where the amount came from;
//   (b) the base itself — `amountMinor`, already computed by the sender.
//
// Both may come together only when they agree. This function is the ONE place
// that decides; no caller multiplies. The commission engine keeps reading
// `amountMinor` only.
//
// PURE and dependency-free apart from the column bound. Unit-tested in
// scripts/test/affiliate-payment-base-rule.test.mjs.

import { MAX_AMOUNT_MINOR } from './affiliateCommissionRule';

export type PaymentBaseIssue =
  | 'amount_required' // neither the base nor a breakdown was given
  | 'incomplete_breakdown' // only one of transaction count and unit price
  | 'transaction_count' // not a whole number of at least 1
  | 'unit_price' // not a whole number of minor units of at least 0
  | 'amount_range' // the product is zero or does not fit the column
  | 'amount_mismatch'; // a breakdown and a base were both given and differ

export interface PaymentBaseInput {
  amountMinor?: number | null;
  transactionCount?: number | null;
  unitPriceMinor?: number | null;
}

export type PaymentBase =
  | { ok: true; amountMinor: number; transactionCount: number | null; unitPriceMinor: number | null }
  | { ok: false; issue: PaymentBaseIssue };

const given = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/**
 * Decides the base. With the base alone it is returned as given — its own
 * range check stays with the payment shape check (`checkPaymentInput`, issue
 * `amount`), so a bare amount is judged exactly as before #3552.
 */
export function resolvePaymentBase(input: PaymentBaseInput): PaymentBase {
  const { amountMinor, transactionCount, unitPriceMinor } = input;
  const hasCount = given(transactionCount);
  const hasPrice = given(unitPriceMinor);

  if (!hasCount && !hasPrice) {
    if (!given(amountMinor)) return { ok: false, issue: 'amount_required' };
    return { ok: true, amountMinor, transactionCount: null, unitPriceMinor: null };
  }
  if (!hasCount || !hasPrice) return { ok: false, issue: 'incomplete_breakdown' };
  if (!Number.isSafeInteger(transactionCount) || transactionCount < 1) return { ok: false, issue: 'transaction_count' };
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) return { ok: false, issue: 'unit_price' };

  const product = transactionCount * unitPriceMinor;
  // A zero base earns nothing and the column refuses it; past the bound it does not fit.
  if (product < 1 || product > MAX_AMOUNT_MINOR) return { ok: false, issue: 'amount_range' };
  if (given(amountMinor) && amountMinor !== product) return { ok: false, issue: 'amount_mismatch' };
  return { ok: true, amountMinor: product, transactionCount, unitPriceMinor };
}
