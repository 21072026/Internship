// The placement ledger's rule (#1765, docs/placements.md) — pure, no Prisma,
// unit-tested in scripts/test/placement-rule.test.mjs.
//
// A `Placement` is the billable fact behind a hire: which company, which role,
// on what date, credited to which mentor and which source, and whether it has
// been invoiced. It OBSERVES the pipeline — it never moves a stage, closes a
// relation or tells the mentee anything.
//
// The stamp is a RECONCILIATION, not a reaction to one event: the subscriber
// reads the relation as it is now and asks `reconcilePlacement()` what the
// ledger should say. Two quick moves (into the hire stage and straight back
// out) can be delivered in either order, or twice; reading the current state
// makes every delivery converge on the same row.

import type { EmploymentAttribution } from './placementKind';

export const INVOICE_STATES = ['NOT_INVOICEABLE', 'INVOICEABLE', 'INVOICED', 'WAIVED'] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export const FEE_MODELS = ['SUBSCRIPTION', 'SUCCESS_FEE', 'NONE'] as const;
export type FeeModel = (typeof FEE_MODELS)[number];

export function isInvoiceState(value: unknown): value is InvoiceState {
  return typeof value === 'string' && (INVOICE_STATES as readonly string[]).includes(value);
}

export function isFeeModel(value: unknown): value is FeeModel {
  return typeof value === 'string' && (FEE_MODELS as readonly string[]).includes(value);
}

/** A stored attribution, NULL read as THROUGH_US (the #1503 rule for rows from before the column). */
export function effectiveAttribution(stored: string | null | undefined): EmploymentAttribution {
  return stored === 'SELF_FOUND' || stored === 'ALREADY_EMPLOYED' ? stored : 'THROUGH_US';
}

/**
 * What a fresh placement starts as. A hire that is not ours still gets a row —
 * reporting needs it, and honest reporting is the point — but it carries no fee
 * and can never be invoiced. A hire through us is invoiceable; whether the org
 * actually bills per hire is the admin's call (they may waive it).
 */
export function initialLedgerState(attribution: EmploymentAttribution): {
  invoiceState: InvoiceState;
  feeModel: FeeModel | null;
} {
  return attribution === 'THROUGH_US'
    ? { invoiceState: 'INVOICEABLE', feeModel: null }
    : { invoiceState: 'NOT_INVOICEABLE', feeModel: 'NONE' };
}

export interface ExistingPlacement {
  reversedAt: Date | null;
}

export type PlacementAction =
  | { kind: 'create' }
  | { kind: 'reinstate' }
  | { kind: 'reverse' }
  | { kind: 'none' };

/**
 * The one decision. `inHireStage` is whether the relation's CURRENT stage is
 * one of the org's hire stages (resolved by the caller through
 * `outcomeStageKeys()`, never a hardcoded HIRED_660 — #747 lets a tenant name
 * its own stages).
 *
 *   in hire stage, no row         → create
 *   in hire stage, reversed row   → reinstate
 *   left hire stage, live row     → reverse (never delete)
 *   anything else                 → none
 */
export function reconcilePlacement(input: {
  inHireStage: boolean;
  existing: ExistingPlacement | null;
}): PlacementAction {
  const { inHireStage, existing } = input;
  if (inHireStage) {
    if (!existing) return { kind: 'create' };
    return existing.reversedAt ? { kind: 'reinstate' } : { kind: 'none' };
  }
  if (existing && !existing.reversedAt) return { kind: 'reverse' };
  return { kind: 'none' };
}

// Which invoice-state moves an admin may make by hand. NOT_INVOICEABLE is the
// attribution's verdict and is never left by hand (the attribution is what to
// correct); INVOICED is final apart from the explicit undo back to
// INVOICEABLE, which a wrong click needs and the audit log records.
const INVOICE_TRANSITIONS: Readonly<Record<InvoiceState, readonly InvoiceState[]>> = {
  NOT_INVOICEABLE: [],
  INVOICEABLE: ['INVOICED', 'WAIVED'],
  INVOICED: ['INVOICEABLE'],
  WAIVED: ['INVOICEABLE'],
};

export type InvoiceChangeRefusal = 'same_state' | 'not_allowed' | 'reversed' | 'invoice_ref_required';

export function canChangeInvoiceState(input: {
  from: string;
  to: InvoiceState;
  reversed: boolean;
  invoiceRef?: string | null;
}): { ok: true } | { ok: false; code: InvoiceChangeRefusal } {
  const from = isInvoiceState(input.from) ? input.from : 'NOT_INVOICEABLE';
  if (from === input.to) return { ok: false, code: 'same_state' };
  if (!INVOICE_TRANSITIONS[from].includes(input.to)) return { ok: false, code: 'not_allowed' };
  // A hire that was undone is not billed. Undoing an invoice (→ INVOICEABLE)
  // or waiving stays possible, because that is how a reversed hire is settled.
  if (input.reversed && input.to === 'INVOICED') return { ok: false, code: 'reversed' };
  if (input.to === 'INVOICED' && !input.invoiceRef?.trim()) return { ok: false, code: 'invoice_ref_required' };
  return { ok: true };
}

/** The invoice states an admin can move a row to from where it is (the screen's buttons). */
/** A state an admin can move a row TO — never NOT_INVOICEABLE, which only the attribution sets. */
export type ManualInvoiceState = Exclude<InvoiceState, 'NOT_INVOICEABLE'>;

export function nextInvoiceStates(from: string, reversed: boolean): ManualInvoiceState[] {
  const state = isInvoiceState(from) ? from : 'NOT_INVOICEABLE';
  return INVOICE_TRANSITIONS[state].filter(
    (to): to is ManualInvoiceState => to !== 'NOT_INVOICEABLE' && !(reversed && to === 'INVOICED'),
  );
}

/**
 * Integer minor units → "1234.50 EUR", with the currency's own number of
 * decimals (JPY has none) — never a float on the way in (docs/offer-compensation.md).
 */
export function formatMinor(minor: number | null, currency: string | null): string {
  if (minor == null || !currency) return '';
  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // An unknown code keeps the common two decimals rather than failing the export.
  }
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  if (digits === 0) return `${sign}${abs} ${currency}`;
  const unit = 10 ** digits;
  return `${sign}${Math.floor(abs / unit)}.${String(abs % unit).padStart(digits, '0')} ${currency}`;
}
