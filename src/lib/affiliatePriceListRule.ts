// The transaction price list of an affiliate programme (#3843, docs/affiliate-module.md
// § Commission base).
//
// A customer's first paying month earns its partner a one-off commission whose
// base is the LIST PRICE of that month's transaction count, gross (VAT included):
// what the month costs on the published price list, whatever the customer was
// actually invoiced. This file turns a transaction count into that amount.
//
// The price list is the organisation's DATA (AffiliateProgramSettings.priceList);
// nothing here mirrors a real price list, and the tests use synthetic numbers
// only (CLAUDE.md, "Tenant names never enter this repo"). Its shape:
//
//   - `freeUpTo`: a month with at most this many transactions costs nothing;
//   - `baseCovers` / `baseFeeMilli`: the first month above the free limit pays a
//     base fee that covers the first `baseCovers` transactions;
//   - `steps`: every transaction after that costs its step's unit price; a step
//     covers up to `upTo` (inclusive), the last one is open-ended (`upTo: null`);
//   - `vatBps`: VAT added on top, in basis points; `reverseChargeAddsVat` says
//     whether it is also added for a customer invoiced without VAT (reverse
//     charge, `AffiliateCustomer.reverseCharge`).
//
// Prices are integer MILLI-minor units (1/1000 of a cent for EUR), because a
// per-transaction price may be a fraction of a cent. The month is summed exactly,
// VAT is applied, and the result is rounded to whole minor units ONCE, at the
// end, half up — never per transaction. BigInt keeps the sum exact for any count
// the input bound allows.
//
// PURE and dependency-free apart from the column bound. Unit-tested in
// scripts/test/affiliate-price-list-rule.test.mjs.

import { MAX_AMOUNT_MINOR } from './affiliateCommissionRule';

/** Milli-minor units per minor unit. */
export const MILLI_PER_MINOR = 1_000;
export const MAX_PRICE_STEPS = 10;
/** The largest monthly transaction count a payment may carry. */
export const MAX_TRANSACTION_COUNT = 100_000_000;
/** Upper bound of one price (base fee or unit price): 1 000 000.000 in major units. */
export const MAX_PRICE_MILLI = 100_000_000_000;

export interface PriceStep {
  /** Inclusive last transaction of the step; null = open-ended (the last step only). */
  upTo: number | null;
  /** Price of one transaction in this step, milli-minor units. */
  unitMilli: number;
}

export interface PriceList {
  freeUpTo: number;
  baseCovers: number;
  baseFeeMilli: number;
  steps: PriceStep[];
  vatBps: number;
  reverseChargeAddsVat: boolean;
}

export interface PriceListIssue {
  field: string;
  code: 'required' | 'type' | 'range' | 'order';
}

export type PriceListParse = { ok: true; priceList: PriceList } | { ok: false; issues: PriceListIssue[] };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

function intIn(issues: PriceListIssue[], field: string, v: unknown, min: number, max: number): number {
  if (v === undefined || v === null) {
    issues.push({ field, code: 'required' });
    return 0;
  }
  if (!isInt(v)) {
    issues.push({ field, code: 'type' });
    return 0;
  }
  if (v < min || v > max) issues.push({ field, code: 'range' });
  return v;
}

/**
 * Validates an untrusted price list (a request body, a JSON column). Returns
 * every problem at once, so the settings form can mark all fields in one round.
 */
export function parsePriceList(input: unknown): PriceListParse {
  const issues: PriceListIssue[] = [];
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  const freeUpTo = intIn(issues, 'freeUpTo', o.freeUpTo, 0, MAX_TRANSACTION_COUNT);
  const baseCovers = intIn(issues, 'baseCovers', o.baseCovers, 1, MAX_TRANSACTION_COUNT);
  if (isInt(o.freeUpTo) && isInt(o.baseCovers) && baseCovers <= freeUpTo) issues.push({ field: 'baseCovers', code: 'order' });
  const baseFeeMilli = intIn(issues, 'baseFeeMilli', o.baseFeeMilli, 0, MAX_PRICE_MILLI);
  const vatBps = intIn(issues, 'vatBps', o.vatBps, 0, 10_000);

  let reverseChargeAddsVat = true;
  if (o.reverseChargeAddsVat === undefined || o.reverseChargeAddsVat === null) issues.push({ field: 'reverseChargeAddsVat', code: 'required' });
  else if (typeof o.reverseChargeAddsVat !== 'boolean') issues.push({ field: 'reverseChargeAddsVat', code: 'type' });
  else reverseChargeAddsVat = o.reverseChargeAddsVat;

  const steps: PriceStep[] = [];
  if (!Array.isArray(o.steps)) {
    issues.push({ field: 'steps', code: o.steps === undefined ? 'required' : 'type' });
  } else if (o.steps.length === 0 || o.steps.length > MAX_PRICE_STEPS) {
    issues.push({ field: 'steps', code: 'range' });
  } else {
    let floor = baseCovers;
    o.steps.forEach((raw, i) => {
      const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const last = i === (o.steps as unknown[]).length - 1;
      let upTo: number | null = null;
      if (last) {
        // The last step is open-ended: a count above every bound must have a price.
        if (s.upTo !== null && s.upTo !== undefined) issues.push({ field: `steps.${i}.upTo`, code: 'type' });
      } else {
        upTo = intIn(issues, `steps.${i}.upTo`, s.upTo, 1, MAX_TRANSACTION_COUNT);
        if (isInt(s.upTo) && upTo <= floor) issues.push({ field: `steps.${i}.upTo`, code: 'order' });
        if (isInt(s.upTo)) floor = upTo;
      }
      const unitMilli = intIn(issues, `steps.${i}.unitMilli`, s.unitMilli, 0, MAX_PRICE_MILLI);
      steps.push({ upTo, unitMilli });
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, priceList: { freeUpTo, baseCovers, baseFeeMilli, steps, vatBps, reverseChargeAddsVat } };
}

/** A stored price list, or null when none is configured or the stored value no longer parses. */
export function readStoredPriceList(raw: unknown): PriceList | null {
  if (raw === null || raw === undefined) return null;
  const parsed = parsePriceList(raw);
  return parsed.ok ? parsed.priceList : null;
}

/** The price list as one string with a fixed key order — the shape that is compared. */
export function canonicalPriceList(p: PriceList | null): string {
  if (!p) return 'null';
  return JSON.stringify([p.freeUpTo, p.baseCovers, p.baseFeeMilli, p.steps.map((s) => [s.upTo, s.unitMilli]), p.vatBps, p.reverseChargeAddsVat]);
}

/** The net price of a month in milli-minor units, exact. 0 at or below the free limit. */
export function netMilli(p: PriceList, transactions: number): bigint {
  if (transactions <= p.freeUpTo) return BigInt(0);
  let net = BigInt(p.baseFeeMilli);
  let done = p.baseCovers;
  for (const step of p.steps) {
    if (done >= transactions) break;
    const hi = step.upTo === null ? transactions : Math.min(step.upTo, transactions);
    if (hi > done) net += BigInt(hi - done) * BigInt(step.unitMilli);
    done = Math.max(done, hi);
  }
  return net;
}

/** Whether VAT is added for this customer. */
export function vatApplies(p: PriceList, reverseCharge: boolean): boolean {
  return !reverseCharge || p.reverseChargeAddsVat;
}

export type ListPrice =
  | { ok: true; amountMinor: number; netMilli: bigint; vatBps: number }
  | { ok: false; issue: 'transaction_count' | 'amount_range' };

/**
 * The gross list price of a month with `transactions` transactions, in whole
 * minor units: net summed exactly, VAT added, rounded half up once. 0 means the
 * month is free — not a payment (the commission engine counts nothing at 0).
 */
export function listPriceMinor(p: PriceList, transactions: number, opts: { reverseCharge?: boolean } = {}): ListPrice {
  if (!Number.isSafeInteger(transactions) || transactions < 1 || transactions > MAX_TRANSACTION_COUNT) {
    return { ok: false, issue: 'transaction_count' };
  }
  const net = netMilli(p, transactions);
  const vatBps = vatApplies(p, opts.reverseCharge === true) ? p.vatBps : 0;
  // gross milli × 10 000 = net × (10 000 + vat); one division with half-up rounding.
  const scaled = net * BigInt(10_000 + vatBps);
  const divisor = BigInt(MILLI_PER_MINOR * 10_000);
  const minor = (scaled + divisor / BigInt(2)) / divisor;
  if (minor > BigInt(MAX_AMOUNT_MINOR)) return { ok: false, issue: 'amount_range' };
  return { ok: true, amountMinor: Number(minor), netMilli: net, vatBps };
}
