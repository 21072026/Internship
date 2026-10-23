// Taking over a previous system's affiliate history (docs/affiliate-module.md, #3118)
// — PURE and dependency-free (scripts/test/affiliate-migration-rule.test.mjs).
//
// Three CSV files: partners, commissions, payouts. This module reads their rows
// (the shared parser in src/lib/importPreview.ts produces the tables) and judges
// the set as a whole. The writer (src/lib/affiliateMigration.ts) runs only a set
// with no issue at all, in one transaction:
//
// - codes are taken verbatim (a number or a slug), compared case-insensitively
//   like the database does;
// - commissions are taken AS RECORDED — amount, status, due day, payout — and
//   never recomputed (they are stored with kind IMPORTED and their payments with
//   source IMPORT, which the payment writer leaves alone);
// - every PAID commission belongs to a payout of the same partner, and a payout's
//   amount is exactly the sum of its commissions;
// - RECONCILIATION: per partner, the PAID sum and the unpaid (PENDING + APPROVED)
//   sum must equal the totals the source reports in the partners file, to the
//   cent. A difference blocks the whole migration.
//
// Amounts are euros as written in the source ("19,99", "1.234,50", "19.99");
// days are YYYY-MM-DD. Clicks are not part of a migration.

import { headerIndex, type ParsedRow, type ParsedTable, type ValidatedRow } from './importPreview';
import { parseMinorUnits } from './money';
import { parseCalendarDay } from './calendarDay';

export const MIGRATION_MAX_ROWS = { partners: 5_000, commissions: 50_000, payouts: 20_000 } as const;
/** The largest amount a column holds (a signed 32-bit INT). */
const MAX_MINOR = 2_147_483_647;
const MAX_REF = 120;
const MAX_CODE = 100;
const MAX_NAME = 160;
const MAX_EMAIL = 191;

export type MigrationFile = 'partners' | 'commissions' | 'payouts';

export const MIGRATION_COLUMNS: Record<MigrationFile, { required: readonly string[]; optional: readonly string[] }> = {
  partners: { required: ['code', 'name', 'paid_total', 'unpaid_total'], optional: ['email', 'status', 'ended_on'] },
  commissions: {
    required: ['partner_code', 'customer_ref', 'payment_ref', 'payment_amount', 'payment_date', 'commission_amount', 'status'],
    optional: ['due_date', 'payout_ref'],
  },
  payouts: { required: ['payout_ref', 'partner_code', 'amount', 'paid_date'], optional: ['bank_reference'] },
};

export type MigrationIssueCode =
  | 'missing_column'
  | 'too_many_rows'
  | 'required'
  | 'too_long'
  | 'invalid_code'
  | 'invalid_email'
  | 'invalid_amount'
  | 'invalid_date'
  | 'future_date'
  | 'invalid_status'
  | 'ended_on_required'
  | 'duplicate'
  | 'unknown_partner'
  | 'unknown_payout'
  | 'payout_other_partner'
  | 'paid_without_payout'
  | 'payout_on_unpaid'
  | 'payout_sum'
  | 'payout_empty'
  | 'customer_two_partners'
  | 'reconciliation';

export interface MigrationIssue {
  file: MigrationFile;
  /** 1-based data row; null for a whole-file or per-partner issue. */
  row: number | null;
  code: MigrationIssueCode;
  /** The column, or the partner code / payout ref the issue is about. */
  subject?: string;
}

export type PartnerStatus = 'ACTIVE' | 'SUSPENDED' | 'TERMINATED';
export type CommissionStatus = 'PENDING' | 'APPROVED' | 'PAID' | 'REJECTED';

export interface MigrationPartner {
  row: number;
  code: string;
  displayName: string;
  contactEmail: string | null;
  status: PartnerStatus;
  noticeEffectiveAt: Date | null;
  paidMinor: number;
  unpaidMinor: number;
}

export interface MigrationCommission {
  row: number;
  partnerCode: string;
  customerRef: string;
  paymentRef: string;
  paymentAmountMinor: number;
  receivedAt: Date;
  amountMinor: number;
  status: CommissionStatus;
  dueAt: Date;
  payoutRef: string | null;
}

export interface MigrationPayout {
  row: number;
  ref: string;
  partnerCode: string;
  amountMinor: number;
  paidAt: Date;
  reference: string | null;
}

export interface ReconciliationRow {
  code: string;
  expectedPaidMinor: number;
  expectedUnpaidMinor: number;
  paidMinor: number;
  unpaidMinor: number;
  ok: boolean;
}

const PARTNER_STATUSES: readonly PartnerStatus[] = ['ACTIVE', 'SUSPENDED', 'TERMINATED'];
const COMMISSION_STATUSES: readonly CommissionStatus[] = ['PENDING', 'APPROVED', 'PAID', 'REJECTED'];
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The key two values are the same under (the database compares case-insensitively). */
export const sameKey = (value: string) => value.trim().toLowerCase();

export function missingColumns(file: MigrationFile, header: string[]): string[] {
  return MIGRATION_COLUMNS[file].required.filter((c) => headerIndex(header, c) < 0);
}

/** Reads one row's cells by column name. */
function cells(header: string[], row: ParsedRow) {
  return (name: string) => {
    const i = headerIndex(header, name);
    return i < 0 ? '' : (row.values[i] ?? '').trim();
  };
}

type Field<T> = { ok: true; value: T } | { ok: false; code: MigrationIssueCode };

function amount(raw: string, allowZero: boolean): Field<number> {
  if (!raw) return { ok: false, code: 'required' };
  const minor = parseMinorUnits(raw);
  if (minor === null || Number.isNaN(minor) || minor < 0 || (!allowZero && minor === 0) || minor > MAX_MINOR) return { ok: false, code: 'invalid_amount' };
  return { ok: true, value: minor };
}

function day(raw: string, now: Date): Field<Date> {
  if (!raw) return { ok: false, code: 'required' };
  const parsed = parseCalendarDay(raw);
  if (!parsed) return { ok: false, code: 'invalid_date' };
  if (parsed.getTime() > now.getTime()) return { ok: false, code: 'future_date' };
  return { ok: true, value: parsed };
}

function text(raw: string, max: number): Field<string> {
  if (!raw) return { ok: false, code: 'required' };
  if (raw.length > max) return { ok: false, code: 'too_long' };
  return { ok: true, value: raw };
}

function code(raw: string): Field<string> {
  const t = text(raw, MAX_CODE);
  if (!t.ok) return t;
  return CODE_RE.test(t.value) ? t : { ok: false, code: 'invalid_code' };
}

/** The partners file: every row, or the issues that stop it. */
export function readPartners(table: ParsedTable): { partners: MigrationPartner[]; issues: MigrationIssue[] } {
  const issues: MigrationIssue[] = missingColumns('partners', table.header).map((c) => ({ file: 'partners', row: null, code: 'missing_column', subject: c }));
  if (issues.length > 0) return { partners: [], issues };
  if (table.rows.length > MIGRATION_MAX_ROWS.partners) return { partners: [], issues: [{ file: 'partners', row: null, code: 'too_many_rows' }] };

  const partners: MigrationPartner[] = [];
  for (const r of table.rows) {
    const get = cells(table.header, r);
    const bad = (subject: string, c: MigrationIssueCode) => issues.push({ file: 'partners', row: r.row, code: c, subject });
    const c = code(get('code'));
    const name = text(get('name').replace(/\s+/g, ' '), MAX_NAME);
    const rawEmail = get('email').toLowerCase();
    const emailOk = rawEmail === '' || (rawEmail.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail));
    const rawStatus = (get('status') || 'ACTIVE').toUpperCase();
    const status = PARTNER_STATUSES.find((s) => s === rawStatus);
    const endedRaw = get('ended_on');
    const ended = endedRaw ? parseCalendarDay(endedRaw) : null;
    const paid = amount(get('paid_total'), true);
    const unpaid = amount(get('unpaid_total'), true);
    const before = issues.length;
    if (!c.ok) bad('code', c.code);
    if (!name.ok) bad('name', name.code);
    if (!emailOk) bad('email', 'invalid_email');
    if (!status) bad('status', 'invalid_status');
    if (endedRaw && !ended) bad('ended_on', 'invalid_date');
    if (status === 'TERMINATED' && !endedRaw) bad('ended_on', 'ended_on_required');
    if (!paid.ok) bad('paid_total', paid.code);
    if (!unpaid.ok) bad('unpaid_total', unpaid.code);
    if (issues.length > before) continue;
    partners.push({
      row: r.row,
      code: (c as { value: string }).value,
      displayName: (name as { value: string }).value,
      contactEmail: rawEmail || null,
      status: status!,
      // Only a termination carries its date; the column means nothing otherwise.
      noticeEffectiveAt: status === 'TERMINATED' ? ended : null,
      paidMinor: (paid as { value: number }).value,
      unpaidMinor: (unpaid as { value: number }).value,
    });
  }
  return { partners, issues };
}

/** The payouts file. */
export function readPayouts(table: ParsedTable, now: Date): { payouts: MigrationPayout[]; issues: MigrationIssue[] } {
  const issues: MigrationIssue[] = missingColumns('payouts', table.header).map((c) => ({ file: 'payouts', row: null, code: 'missing_column', subject: c }));
  if (issues.length > 0) return { payouts: [], issues };
  if (table.rows.length > MIGRATION_MAX_ROWS.payouts) return { payouts: [], issues: [{ file: 'payouts', row: null, code: 'too_many_rows' }] };

  const payouts: MigrationPayout[] = [];
  for (const r of table.rows) {
    const get = cells(table.header, r);
    const bad = (subject: string, c: MigrationIssueCode) => issues.push({ file: 'payouts', row: r.row, code: c, subject });
    const ref = text(get('payout_ref'), MAX_REF);
    const partner = code(get('partner_code'));
    const amt = amount(get('amount'), false);
    const paid = day(get('paid_date'), now);
    const bankRef = get('bank_reference');
    const before = issues.length;
    if (!ref.ok) bad('payout_ref', ref.code);
    if (!partner.ok) bad('partner_code', partner.code);
    if (!amt.ok) bad('amount', amt.code);
    if (!paid.ok) bad('paid_date', paid.code);
    if (bankRef.length > MAX_REF) bad('bank_reference', 'too_long');
    if (issues.length > before) continue;
    payouts.push({
      row: r.row,
      ref: (ref as { value: string }).value,
      partnerCode: (partner as { value: string }).value,
      amountMinor: (amt as { value: number }).value,
      paidAt: (paid as { value: Date }).value,
      reference: bankRef || null,
    });
  }
  return { payouts, issues };
}

/**
 * One commissions row — the shape `runImport`'s `validate` hook takes. The key is
 * the payment reference; the reason of a refusal is `<column>:<issue code>`.
 */
export function validateCommissionRow(row: ParsedRow, header: string[], now: Date): ValidatedRow<MigrationCommission> {
  const get = cells(header, row);
  const key = get('payment_ref') || `row-${row.row}`;
  const fail = (subject: string, c: MigrationIssueCode): ValidatedRow<MigrationCommission> => ({ ok: false, row: row.row, key, status: 'ERROR', reason: `${subject}:${c}` });

  const partner = code(get('partner_code'));
  if (!partner.ok) return fail('partner_code', partner.code);
  const customer = text(get('customer_ref'), MAX_REF);
  if (!customer.ok) return fail('customer_ref', customer.code);
  const payment = text(get('payment_ref'), MAX_REF);
  if (!payment.ok) return fail('payment_ref', payment.code);
  const paymentAmount = amount(get('payment_amount'), false);
  if (!paymentAmount.ok) return fail('payment_amount', paymentAmount.code);
  const received = day(get('payment_date'), now);
  if (!received.ok) return fail('payment_date', received.code);
  const commission = amount(get('commission_amount'), true);
  if (!commission.ok) return fail('commission_amount', commission.code);
  const status = COMMISSION_STATUSES.find((s) => s === get('status').toUpperCase());
  if (!status) return fail('status', get('status') ? 'invalid_status' : 'required');
  // The due day is the source's when it has one; otherwise the payment day.
  const dueRaw = get('due_date');
  const due = dueRaw ? parseCalendarDay(dueRaw) : received.value;
  if (!due) return fail('due_date', 'invalid_date');
  const payoutRef = get('payout_ref');
  if (payoutRef.length > MAX_REF) return fail('payout_ref', 'too_long');
  if (status === 'PAID' && !payoutRef) return fail('payout_ref', 'paid_without_payout');
  if (status !== 'PAID' && payoutRef) return fail('payout_ref', 'payout_on_unpaid');

  return {
    ok: true,
    row: row.row,
    key,
    value: {
      row: row.row,
      partnerCode: partner.value,
      customerRef: customer.value,
      paymentRef: payment.value,
      paymentAmountMinor: paymentAmount.value,
      receivedAt: received.value,
      amountMinor: commission.value,
      status,
      dueAt: due,
      payoutRef: payoutRef || null,
    },
  };
}

/**
 * The cross-file rules and the reconciliation, over rows that each passed their
 * own checks. No issue = the set may be written as it is.
 */
export function checkMigration(input: {
  partners: MigrationPartner[];
  commissions: MigrationCommission[];
  payouts: MigrationPayout[];
}): { issues: MigrationIssue[]; reconciliation: ReconciliationRow[] } {
  const issues: MigrationIssue[] = [];

  const partnerByCode = new Map<string, MigrationPartner>();
  for (const p of input.partners) {
    if (partnerByCode.has(sameKey(p.code))) issues.push({ file: 'partners', row: p.row, code: 'duplicate', subject: p.code });
    else partnerByCode.set(sameKey(p.code), p);
  }

  const payoutByRef = new Map<string, MigrationPayout>();
  for (const p of input.payouts) {
    if (payoutByRef.has(sameKey(p.ref))) issues.push({ file: 'payouts', row: p.row, code: 'duplicate', subject: p.ref });
    else payoutByRef.set(sameKey(p.ref), p);
    if (!partnerByCode.has(sameKey(p.partnerCode))) issues.push({ file: 'payouts', row: p.row, code: 'unknown_partner', subject: p.partnerCode });
  }

  const seenPayments = new Set<string>();
  const customerPartner = new Map<string, string>();
  const payoutSums = new Map<string, number>();
  const totals = new Map<string, { paid: number; unpaid: number }>();
  for (const c of input.commissions) {
    const partnerKey = sameKey(c.partnerCode);
    if (seenPayments.has(sameKey(c.paymentRef))) issues.push({ file: 'commissions', row: c.row, code: 'duplicate', subject: c.paymentRef });
    seenPayments.add(sameKey(c.paymentRef));
    if (!partnerByCode.has(partnerKey)) {
      issues.push({ file: 'commissions', row: c.row, code: 'unknown_partner', subject: c.partnerCode });
      continue;
    }
    // One partner per customer (the database's unique (orgId, externalRef)).
    const owner = customerPartner.get(sameKey(c.customerRef));
    if (owner !== undefined && owner !== partnerKey) issues.push({ file: 'commissions', row: c.row, code: 'customer_two_partners', subject: c.customerRef });
    else customerPartner.set(sameKey(c.customerRef), partnerKey);

    if (c.payoutRef) {
      const payout = payoutByRef.get(sameKey(c.payoutRef));
      if (!payout) issues.push({ file: 'commissions', row: c.row, code: 'unknown_payout', subject: c.payoutRef });
      else if (sameKey(payout.partnerCode) !== partnerKey) issues.push({ file: 'commissions', row: c.row, code: 'payout_other_partner', subject: c.payoutRef });
      else payoutSums.set(sameKey(c.payoutRef), (payoutSums.get(sameKey(c.payoutRef)) ?? 0) + c.amountMinor);
    }

    const t = totals.get(partnerKey) ?? { paid: 0, unpaid: 0 };
    if (c.status === 'PAID') t.paid += c.amountMinor;
    else if (c.status === 'PENDING' || c.status === 'APPROVED') t.unpaid += c.amountMinor;
    totals.set(partnerKey, t);
  }

  for (const p of input.payouts) {
    const sum = payoutSums.get(sameKey(p.ref));
    if (sum === undefined) issues.push({ file: 'payouts', row: p.row, code: 'payout_empty', subject: p.ref });
    else if (sum !== p.amountMinor) issues.push({ file: 'payouts', row: p.row, code: 'payout_sum', subject: p.ref });
  }

  // Over each code's first row only: a duplicate is already an issue of its own.
  const reconciliation: ReconciliationRow[] = [...partnerByCode.values()].map((p) => {
    const t = totals.get(sameKey(p.code)) ?? { paid: 0, unpaid: 0 };
    const ok = t.paid === p.paidMinor && t.unpaid === p.unpaidMinor;
    if (!ok) issues.push({ file: 'partners', row: p.row, code: 'reconciliation', subject: p.code });
    return { code: p.code, expectedPaidMinor: p.paidMinor, expectedUnpaidMinor: p.unpaidMinor, paidMinor: t.paid, unpaidMinor: t.unpaid, ok };
  });

  return { issues, reconciliation };
}
