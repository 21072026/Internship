// The monthly invoice CSV of an affiliate programme (#3846, docs/affiliate-module.md
// § Monthly invoice import) — PURE and dependency-free apart from its siblings
// (scripts/test/affiliate-invoice-import-rule.test.mjs).
//
// The billing side exports last month's invoices once a month; each PAID invoice
// becomes one customer payment. This module judges the file: which column holds
// what (the admin picks them — no column name of any upstream system is written
// in code, the choice is the organisation's data), and what each row says. The
// store (src/lib/affiliateInvoiceImport.ts) runs it on the shared engine
// (`runImport`, src/lib/importPreview.ts): a preview is the same run with a
// writer that does not write.
//
// A row is
//   - SKIP when its status column (if mapped) does not read as the "paid" value,
//     when the paid amount is zero, or when it is negative (a credit note: refunds
//     wait for #3475);
//   - ERROR when a mapped cell is missing or unreadable;
//   - otherwise a payment: reference = the invoice number, the day it counts for =
//     the mapped date (DD.MM.YYYY or YYYY-MM-DD), amount = the PAID gross amount,
//     and — when a transaction column is mapped — the month's transaction count,
//     which the price list turns into the list price the one-off commission is
//     chosen by (#3845).

import { headerIndex, type ParsedRow, type ValidatedRow } from './importPreview';
import { parseMigrationAmount } from './affiliateMigrationRule';

export const INVOICE_IMPORT_MAX_ROWS = 10_000;
/** Longest invoice number kept (the payment reference column). */
const MAX_REF = 120;
const MAX_COLUMN_NAME = 120;

/** Which header holds what. Header names as the file spells them; matched case/space-insensitively. */
export interface InvoiceColumns {
  invoiceRef: string;
  date: string;
  customerRef: string;
  paidAmount: string;
  /** Optional: a currency column; without it every row is in the plan's currency. */
  currency: string | null;
  /** Optional: a payment-status column, and the value that means "paid". */
  status: string | null;
  paidValue: string | null;
  /** Optional: the month's transaction count. */
  transactions: string | null;
}

export const REQUIRED_INVOICE_COLUMNS = ['invoiceRef', 'date', 'customerRef', 'paidAmount'] as const;
export const OPTIONAL_INVOICE_COLUMNS = ['currency', 'status', 'transactions'] as const;

export type ColumnsIssue = { field: keyof InvoiceColumns; code: 'required' | 'not_in_file' | 'type' };

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= MAX_COLUMN_NAME ? v.trim() : null);

/**
 * Validates a column choice against the file's header. Every problem at once, so
 * the screen can mark each select. `header` null: shape only (a stored choice).
 */
export function parseInvoiceColumns(
  input: unknown,
  header: string[] | null,
): { ok: true; columns: InvoiceColumns } | { ok: false; issues: ColumnsIssue[] } {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const issues: ColumnsIssue[] = [];
  const pick = (field: keyof InvoiceColumns, required: boolean): string | null => {
    const raw = o[field];
    if (raw === undefined || raw === null || raw === '') {
      if (required) issues.push({ field, code: 'required' });
      return null;
    }
    const v = text(raw);
    if (v === null) {
      issues.push({ field, code: 'type' });
      return null;
    }
    if (header && headerIndex(header, v) < 0) issues.push({ field, code: 'not_in_file' });
    return v;
  };
  const columns: InvoiceColumns = {
    invoiceRef: pick('invoiceRef', true) ?? '',
    date: pick('date', true) ?? '',
    customerRef: pick('customerRef', true) ?? '',
    paidAmount: pick('paidAmount', true) ?? '',
    currency: pick('currency', false),
    status: pick('status', false),
    paidValue: null,
    transactions: pick('transactions', false),
  };
  // The "paid" value is free text from the file, not a column; required with a status column.
  if (columns.status !== null) {
    const v = text(o.paidValue);
    if (v === null) issues.push({ field: 'paidValue', code: o.paidValue ? 'type' : 'required' });
    else columns.paidValue = v;
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, columns };
}

/** A stored choice, or null when none was saved or it no longer reads. */
export function readStoredInvoiceColumns(raw: unknown): InvoiceColumns | null {
  if (raw === null || raw === undefined) return null;
  const parsed = parseInvoiceColumns(raw, null);
  return parsed.ok ? parsed.columns : null;
}

/** "15.10.2026" or "2026-10-15" → that calendar day at UTC midnight; null when neither. */
export function parseInvoiceDay(raw: string): Date | null {
  const t = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (match) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? at : null;
}

/** Status cells compared the way people type them: case and surrounding space do not matter. */
const sameText = (a: string, b: string) => a.trim().toLocaleLowerCase('de') === b.trim().toLocaleLowerCase('de');

export interface InvoiceRow {
  invoiceRef: string;
  customerRef: string;
  receivedAt: Date;
  paidMinor: number;
  /** Upper-case ISO code from the file, or null without a currency column. */
  currency: string | null;
  transactionCount: number | null;
}

export type InvoiceRowReason =
  | 'missing_invoice_ref'
  | 'invoice_ref_too_long'
  | 'missing_customer'
  | 'bad_date'
  | 'future_date'
  | 'bad_amount'
  | 'bad_currency'
  | 'bad_transactions'
  | 'not_paid'
  | 'zero_amount'
  | 'negative_amount';

/** One data row → a payment, or the reason it is skipped or refused. */
export function validateInvoiceRow(row: ParsedRow, header: string[], columns: InvoiceColumns, now: Date): ValidatedRow<InvoiceRow> {
  const cell = (name: string | null) => (name === null ? '' : (row.values[headerIndex(header, name)] ?? '').trim());
  const invoiceRef = cell(columns.invoiceRef);
  const key = invoiceRef || `#${row.row}`;
  const refuse = (reason: InvoiceRowReason, status: 'SKIP' | 'ERROR' = 'ERROR'): ValidatedRow<InvoiceRow> => ({ ok: false, row: row.row, key, status, reason });

  // Not paid: skipped before anything else is judged — an open invoice may still lack a paid amount.
  if (columns.status !== null && columns.paidValue !== null && !sameText(cell(columns.status), columns.paidValue)) return refuse('not_paid', 'SKIP');

  if (!invoiceRef) return refuse('missing_invoice_ref');
  if (invoiceRef.length > MAX_REF) return refuse('invoice_ref_too_long');
  const customerRef = cell(columns.customerRef);
  if (!customerRef) return refuse('missing_customer');

  const day = parseInvoiceDay(cell(columns.date));
  if (!day) return refuse('bad_date');
  if (day.getTime() > now.getTime()) return refuse('future_date');

  const rawAmount = cell(columns.paidAmount);
  if (/^-/.test(rawAmount)) return refuse('negative_amount', 'SKIP');
  const paidMinor = parseMigrationAmount(rawAmount);
  if (paidMinor === null) return refuse('bad_amount');
  if (paidMinor === 0) return refuse('zero_amount', 'SKIP');

  let currency: string | null = null;
  if (columns.currency !== null) {
    currency = cell(columns.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return refuse('bad_currency');
  }

  let transactionCount: number | null = null;
  if (columns.transactions !== null) {
    const raw = cell(columns.transactions).replace(/[.\s]/g, '');
    if (raw !== '') {
      if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) return refuse('bad_transactions');
      transactionCount = Number(raw);
    }
  }

  return { ok: true, row: row.row, key: invoiceRef, value: { invoiceRef, customerRef, receivedAt: day, paidMinor, currency, transactionCount } };
}
