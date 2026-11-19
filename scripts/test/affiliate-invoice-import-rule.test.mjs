// Unit tests for the monthly invoice CSV rule (src/lib/affiliateInvoiceImportRule.ts,
// docs/affiliate-module.md § Monthly invoice import, #3846).
//
// Run: npm run test:unit
//
// Synthetic headers and invoices only — no column name of a real system.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./ts-extensionless-resolve.mjs', import.meta.url));
const { parseDelimited } = await import('../../src/lib/importPreview.ts');
const { parseInvoiceColumns, readStoredInvoiceColumns, parseInvoiceDay, validateInvoiceRow } = await import('../../src/lib/affiliateInvoiceImportRule.ts');

const CSV = [
  'Invoice No;Invoice Date;Customer No;Gross;Currency;State;Paid;Tx',
  'INV-1;15.10.2026;C-1;45,22;EUR;paid;45,22;250',
  'INV-2;2026-10-20;C-2;1.234,56;eur;Paid;1.234,56;',
  'INV-3;16.10.2026;C-1;10,00;EUR;open;0;12',
  'INV-4;17.10.2026;C-3;-12,00;EUR;paid;-12,00;5',
  'INV-5;31.02.2026;C-3;12,00;EUR;paid;12,00;5',
  ';17.10.2026;C-3;12,00;EUR;paid;12,00;5',
  'INV-7;17.10.2026;C-3;12,00;EURO;paid;12,00;5',
  'INV-8;17.10.2026;C-3;12,00;EUR;paid;0,00;5',
  'INV-9;17.10.2026;C-3;12,00;EUR;paid;12,00;1,5',
  'INV-10;17.12.2099;C-3;12,00;EUR;paid;12,00;5',
].join('\n');
const table = parseDelimited(CSV);
const COLUMNS = {
  invoiceRef: 'Invoice No',
  date: 'Invoice Date',
  customerRef: 'Customer No',
  paidAmount: 'Paid',
  currency: 'Currency',
  status: 'State',
  paidValue: 'paid',
  transactions: 'Tx',
};
const NOW = new Date('2026-11-01T00:00:00Z');
const judge = (i, columns = COLUMNS) => validateInvoiceRow(table.rows[i], table.header, columns, NOW);
const outcome = (v) => (v.ok ? 'OK' : `${v.status}:${v.reason}`);

test('a column choice is checked against the file, every problem at once', () => {
  assert.deepEqual(parseInvoiceColumns(COLUMNS, table.header), { ok: true, columns: COLUMNS });
  // Headers match case- and space-insensitively.
  assert.equal(parseInvoiceColumns({ ...COLUMNS, invoiceRef: '  invoice no ' }, table.header).ok, true);
  const bad = parseInvoiceColumns({ ...COLUMNS, date: '', paidAmount: 'Amount', paidValue: '' }, table.header);
  assert.deepEqual(bad.issues.map((i) => `${i.field}:${i.code}`).sort(), ['date:required', 'paidAmount:not_in_file', 'paidValue:required']);
});

test('optional columns may be left out; a status needs its "paid" value', () => {
  const minimal = { invoiceRef: 'Invoice No', date: 'Invoice Date', customerRef: 'Customer No', paidAmount: 'Paid' };
  assert.deepEqual(parseInvoiceColumns(minimal, table.header).columns, { ...minimal, currency: null, status: null, paidValue: null, transactions: null });
  assert.deepEqual(parseInvoiceColumns({ ...minimal, status: 'State' }, table.header).issues, [{ field: 'paidValue', code: 'required' }]);
});

test('a stored choice reads without a file; garbage reads as none', () => {
  assert.deepEqual(readStoredInvoiceColumns(COLUMNS), COLUMNS);
  assert.equal(readStoredInvoiceColumns({ invoiceRef: 5 }), null);
  assert.equal(readStoredInvoiceColumns(null), null);
});

test('days read as DD.MM.YYYY or YYYY-MM-DD, at UTC midnight; impossible dates are refused', () => {
  assert.equal(parseInvoiceDay('15.10.2026').toISOString(), '2026-10-15T00:00:00.000Z');
  assert.equal(parseInvoiceDay('5.1.2026').toISOString(), '2026-01-05T00:00:00.000Z');
  assert.equal(parseInvoiceDay('2026-10-20').toISOString(), '2026-10-20T00:00:00.000Z');
  for (const raw of ['31.02.2026', '2026/10/20', '10-20-2026', '', '15.10.26']) assert.equal(parseInvoiceDay(raw), null, raw);
});

test('a paid row becomes a payment: the PAID amount, the currency, the transactions', () => {
  assert.deepEqual(judge(0), {
    ok: true,
    row: 1,
    key: 'INV-1',
    value: { invoiceRef: 'INV-1', customerRef: 'C-1', receivedAt: new Date('2026-10-15T00:00:00Z'), paidMinor: 4_522, currency: 'EUR', transactionCount: 250 },
  });
  // Thousands separators, a lower-case currency and a status in another case; no transactions.
  const second = judge(1);
  assert.equal(second.ok, true);
  assert.deepEqual([second.value.paidMinor, second.value.currency, second.value.transactionCount], [123_456, 'EUR', null]);
});

test('unpaid, credit-note and zero rows are skipped; unreadable ones are errors', () => {
  assert.deepEqual(table.rows.map((_, i) => outcome(judge(i))), [
    'OK',
    'OK',
    'SKIP:not_paid',
    'SKIP:negative_amount',
    'ERROR:bad_date',
    'ERROR:missing_invoice_ref',
    'ERROR:bad_currency',
    'SKIP:zero_amount',
    'ERROR:bad_transactions',
    'ERROR:future_date',
  ]);
});

test('without a status column every row counts as paid', () => {
  const v = judge(2, { ...COLUMNS, status: null, paidValue: null });
  assert.equal(outcome(v), 'SKIP:zero_amount');
  assert.equal(outcome(judge(0, { ...COLUMNS, status: null, paidValue: null })), 'OK');
});
