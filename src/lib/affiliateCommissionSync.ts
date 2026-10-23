// Reconciling stored commissions with the engine (docs/affiliate-module.md, #3114).
//
// PURE and dependency-free. The writer (src/lib/affiliatePaymentWriter.ts) reads a
// partner's payments and commissions under the partner's row lock, runs the engine
// (src/lib/affiliateCommissionRule.ts, evaluatePartner) over the WHOLE history and
// asks this module what to change. Three rules decide it:
//
// - A commission is a projection while it is PENDING and was computed under the
//   CURRENT plan version: it is created, updated or removed to match the engine.
// - Anything else is frozen: APPROVED, PAID and REJECTED rows, and a PENDING row of
//   an older plan version ("a plan change applies to payments received after it").
//   A frozen row is never changed; when the engine disagrees with it, the
//   difference is reported as DRIFT for the admin to look at.
// - Only the engine's outcome is compared, never a row's status or payout.

import { MAX_AMOUNT_MINOR, type PartnerEvaluation, type PaymentFact } from './affiliateCommissionRule';

export const MAX_REF_LENGTH = 120;

/**
 * External references (a payment's, a customer's) are stored trimmed. The
 * database compares them case-insensitively (utf8mb4_unicode_ci), so `INV-1` and
 * `inv-1` are the same reference — decided, docs/affiliate-module.md.
 */
export function normalizeRef(value: string): string {
  return typeof value === 'string' ? value.trim() : value;
}

export type CommissionStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'REJECTED';

export interface StoredCommission {
  id: string;
  paymentId: string;
  kind: 'TIER' | 'PERCENT';
  amountMinor: number;
  currency: string;
  dueAt: Date;
  windowEndsAt: Date | null;
  planVersion: number;
  status: CommissionStatus;
}

export interface CommissionValues {
  kind: 'TIER' | 'PERCENT';
  amountMinor: number;
  currency: string;
  accruedAt: Date;
  dueAt: Date;
  windowEndsAt: Date | null;
  planVersion: number;
}

export interface CommissionCreate extends CommissionValues {
  paymentId: string;
  customerId: string;
}

export interface CommissionDrift {
  /** Null when no row exists: the payment was recorded before the current plan took effect. */
  commissionId: string | null;
  paymentId: string;
  status: CommissionStatus | null;
  planVersion: number | null;
  /** What the engine says today; null = nothing should accrue. */
  expected: { kind: 'TIER' | 'PERCENT'; amountMinor: number } | null;
}

export interface CommissionChanges {
  create: CommissionCreate[];
  update: { id: string; data: CommissionValues }[];
  /** PENDING rows of the current plan version that no longer accrue. */
  remove: string[];
  drift: CommissionDrift[];
}

const sameInstant = (a: Date | null, b: Date | null) => (a === null ? b === null : b !== null && a.getTime() === b.getTime());

export function planCommissionChanges(input: {
  evaluation: PartnerEvaluation;
  payments: PaymentFact[];
  stored: StoredCommission[];
  planVersion: number;
  /**
   * Payments RECORDED before the current plan took effect. The new plan never
   * creates a commission for them retroactively; what it would give is drift.
   */
  recordedBeforePlan?: ReadonlySet<string>;
}): CommissionChanges {
  const paymentById = new Map(input.payments.map((p) => [p.id, p]));
  const storedByPayment = new Map(input.stored.map((c) => [c.paymentId, c]));
  const out: CommissionChanges = { create: [], update: [], remove: [], drift: [] };

  for (const ev of input.evaluation.payments) {
    const existing = storedByPayment.get(ev.paymentId);
    const payment = paymentById.get(ev.paymentId);
    const earns = ev.outcome.kind !== 'NONE' && payment !== undefined && ev.dueAt !== null;
    const live = existing !== undefined && existing.status === 'PENDING' && existing.planVersion === input.planVersion;

    if (earns) {
      const outcome = ev.outcome as { kind: 'TIER' | 'PERCENT'; amountMinor: number };
      const values: CommissionValues = {
        kind: outcome.kind,
        amountMinor: outcome.amountMinor,
        currency: payment.currency,
        accruedAt: payment.receivedAt,
        dueAt: ev.dueAt!,
        windowEndsAt: ev.windowEndsAt,
        planVersion: input.planVersion,
      };
      if (!existing) {
        if (input.recordedBeforePlan?.has(ev.paymentId)) {
          out.drift.push({ commissionId: null, paymentId: ev.paymentId, status: null, planVersion: null, expected: { kind: outcome.kind, amountMinor: outcome.amountMinor } });
        } else {
          out.create.push({ ...values, paymentId: ev.paymentId, customerId: ev.customerId });
        }
        continue;
      }
      const same =
        existing.kind === values.kind &&
        existing.amountMinor === values.amountMinor &&
        existing.currency === values.currency &&
        sameInstant(existing.dueAt, values.dueAt) &&
        sameInstant(existing.windowEndsAt, values.windowEndsAt);
      if (same) continue;
      if (live) out.update.push({ id: existing.id, data: values });
      else if (existing.status !== 'REJECTED') out.drift.push(driftOf(existing, outcome));
      continue;
    }

    if (!existing) continue;
    if (live) out.remove.push(existing.id);
    else if (existing.status !== 'REJECTED') out.drift.push(driftOf(existing, null));
  }
  return out;
}

function driftOf(c: StoredCommission, expected: CommissionDrift['expected']): CommissionDrift {
  return {
    commissionId: c.id,
    paymentId: c.paymentId,
    status: c.status,
    planVersion: c.planVersion,
    expected: expected ? { kind: expected.kind, amountMinor: expected.amountMinor } : null,
  };
}

export type PaymentInputIssue =
  | 'amount' // not a positive integer within the column's range
  | 'currency' // not an ISO 4217 code
  | 'received_at' // not a date, or in the future
  | 'payment_ref' // empty or too long
  | 'customer_ref'; // empty or too long

export interface PaymentInputShape {
  amountMinor: number;
  currency: string;
  receivedAt: Date;
  externalPaymentRef: string;
  customerExternalRef: string;
}

/** Shape checks a payment must pass before the writer takes a lock. References are judged trimmed. */
export function checkPaymentInput(input: PaymentInputShape, now: Date): PaymentInputIssue[] {
  const issues: PaymentInputIssue[] = [];
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > MAX_AMOUNT_MINOR) issues.push('amount');
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) issues.push('currency');
  if (!(input.receivedAt instanceof Date) || Number.isNaN(input.receivedAt.getTime()) || input.receivedAt.getTime() > now.getTime()) {
    issues.push('received_at');
  }
  const refOk = (v: unknown) => typeof v === 'string' && normalizeRef(v).length > 0 && normalizeRef(v).length <= MAX_REF_LENGTH;
  if (!refOk(input.externalPaymentRef)) issues.push('payment_ref');
  if (!refOk(input.customerExternalRef)) issues.push('customer_ref');
  return issues;
}
