import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * The monthly invoice CSV (#3846, src/lib/affiliateInvoiceImport.ts): the admin
 * picks the columns, previews (nothing written), imports; each paid invoice is a
 * payment through the one writer (source INVOICE) with its list price beside it;
 * a re-upload adds nothing, a month typed by hand is not counted twice, and the
 * column choice comes back next time. The row rules are pinned by
 * scripts/test/affiliate-invoice-import-rule.test.mjs.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org, invented headers, invoices and prices.
 */

const PW = 'AffInvoice123!';
const host = asHost(MARKETING_HOST);
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PLAN = {
  currency: 'EUR',
  // A first payment up to 30.00 earns 3.00, above it 9.00: the list price (24.40) and
  // the paid amount (119.00) of the imported invoice fall in different bands.
  tiers: [{ upToMinor: 3_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 1_000,
  switchAtCustomer: 3,
  boundaryCustomer: 'PERCENT',
  windowMonths: 24,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
  monthAligned: true,
  timeZone: 'Europe/Berlin',
};
// 5 free, 5.00 base for the first 6, then 0.10; no VAT.
const PRICE_LIST = { freeUpTo: 5, baseCovers: 6, baseFeeMilli: 500_000, steps: [{ upTo: null, unitMilli: 10_000 }], vatBps: 0, reverseChargeAddsVat: true };
const C1 = `C1-${STAMP}`;
const C2 = `C2-${STAMP}`;
const ref = (n: number) => `INV-${n}-${STAMP}`;
// Invented headers: the admin maps them, nothing in the code knows them.
const CSV = [
  'Bill No;Bill Date;Client;Net;Gross;Cur;State;Settled;Tx',
  `${ref(1)};15.10.2026;${C1};38;45,22;EUR;settled;45,22;250`, // C1's October: typed by hand already → skipped
  `${ref(2)};16.10.2026;${C2};100;119,00;EUR;settled;119,00;200`, // new: paid 119.00, list 24.40
  `${ref(3)};17.10.2026;${C2};10;11,90;EUR;open;0;20`, // not paid
  `${ref(4)};18.10.2026;UNKNOWN-${STAMP};10;11,90;EUR;settled;11,90;20`, // no partner brought it
].join('\n');
const COLUMNS = { invoiceRef: 'Bill No', date: 'Bill Date', customerRef: 'Client', paidAmount: 'Settled', currency: 'Cur', status: 'State', paidValue: 'settled', transactions: 'Tx' };

let orgId = '';
let partnerId = '';
let email = '';
let api: APIRequestContext;

const upload = (data: Record<string, unknown>) => api.post('/api/admin/affiliate/invoices/import', { headers: host, data });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales Invoices ${STAMP}`, slug: `aff-inv-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date('2026-01-01T00:00:00Z'), priceList: PRICE_LIST } });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: `inv-${STAMP}`, displayName: 'Invoice Partner' } })).id;
  email = uniqueEmail('aff-inv-admin');
  await seedUser(email, PW, 'ADMIN', 'Invoice Admin', { orgId });
  api = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(api, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
  // C1's first month was typed by transaction count; C2 is known but has paid nothing yet.
  const typed = await api.post('/api/admin/affiliate/payments', {
    headers: host,
    data: { partnerId, customerExternalRef: C1, transactionCount: 20, receivedOn: '2026-10-01', externalPaymentRef: '' },
  });
  expect(typed.status()).toBe(201);
  await prisma.affiliateCustomer.create({ data: { orgId, partnerId, externalRef: C2 } });
});

test.afterAll(async () => {
  await api?.dispose();
  if (orgId) {
    const where = { orgId };
    await prisma.affiliateCommission.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where }).catch(() => {});
  }
  if (email) await cleanupByEmail(email);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('without a column choice the server answers with the header; a preview writes nothing', async () => {
  const first = await upload({ csv: CSV, dryRun: true });
  expect(first.status()).toBe(400);
  const body = await first.json();
  expect(body.code).toBe('columns');
  expect(body.header).toEqual(['Bill No', 'Bill Date', 'Client', 'Net', 'Gross', 'Cur', 'State', 'Settled', 'Tx']);

  const before = await prisma.affiliatePayment.count({ where: { orgId } });
  const preview = await upload({ csv: CSV, columns: COLUMNS, dryRun: true });
  expect(preview.status()).toBe(200);
  const p = await preview.json();
  expect(p.counts).toMatchObject({ CREATE: 1, SKIP: 3, ERROR: 0 });
  const reasons = Object.fromEntries(p.rows.map((r: { key: string; status: string; reason: string | null }) => [r.key, `${r.status}:${r.reason}`]));
  expect(reasons).toEqual({
    [ref(1)]: 'SKIP:month_recorded',
    [ref(2)]: 'CREATE:null',
    [ref(3)]: 'SKIP:not_paid',
    [ref(4)]: 'SKIP:unknown_customer',
  });
  // 200 transactions: 5.00 + 194 × 0.10 = 24.40.
  expect(p.rows.find((r: { key: string }) => r.key === ref(2))).toMatchObject({ paidMinor: 11_900, listAmountMinor: 2_440, transactionCount: 200 });
  expect(await prisma.affiliatePayment.count({ where: { orgId } })).toBe(before);
  expect(await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } }).then((s) => s.invoiceColumns)).toBeNull();
});

test('the import writes the paid invoice through the writer; the tier follows the list price', async () => {
  const res = await upload({ csv: CSV, columns: COLUMNS, dryRun: false });
  expect(res.status()).toBe(200);
  expect((await res.json()).counts).toMatchObject({ CREATE: 1, SKIP: 3 });
  const paid = await prisma.affiliatePayment.findFirstOrThrow({
    where: { orgId, externalPaymentRef: ref(2) },
    select: { amountMinor: true, listAmountMinor: true, transactionCount: true, unitPriceMinor: true, source: true, receivedAt: true, commission: { select: { kind: true, amountMinor: true } } },
  });
  expect(paid).toMatchObject({ amountMinor: 11_900, listAmountMinor: 2_440, transactionCount: 200, unitPriceMinor: null, source: 'INVOICE' });
  expect(paid.receivedAt.toISOString()).toBe('2026-10-16T00:00:00.000Z');
  // 2nd customer: the band is picked by the list price 24.40 (→ 3.00), not by the paid 119.00 (→ 9.00).
  expect(paid.commission).toEqual({ kind: 'TIER', amountMinor: 300 });
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.invoice_import' } })).toBe(1);
  expect((await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } })).invoiceColumns).toMatchObject(COLUMNS);
});

test('a re-upload adds nothing, and the saved columns are used when none are sent', async () => {
  const res = await upload({ csv: CSV, dryRun: false });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.columns).toMatchObject(COLUMNS);
  expect(body.counts).toMatchObject({ CREATE: 0, UNCHANGED: 1, SKIP: 3 });
  expect(await prisma.affiliatePayment.count({ where: { orgId, source: 'INVOICE' } })).toBe(1);
});

test('the screen: choose the file, the saved columns come back, preview, then import', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, email, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/invoices');
  const next = [
    'Bill No;Bill Date;Client;Net;Gross;Cur;State;Settled;Tx',
    `${ref(5)};03.11.2026;${C2};10;12,50;EUR;settled;12,50;`,
  ].join('\n');
  await page.getByTestId('invoice-file').setInputFiles({ name: 'invoices.csv', mimeType: 'text/csv', buffer: Buffer.from(next) });
  await expect(page.getByTestId('invoice-column-invoiceRef')).toHaveValue('Bill No');
  await expect(page.getByTestId('invoice-report-title')).toContainText(/Preview/);
  await expect(page.getByTestId('invoice-count-CREATE')).toHaveText('1 new');
  await expect(page.getByTestId('invoice-row').filter({ hasText: ref(5) })).toHaveAttribute('data-status', 'CREATE');
  expect(await prisma.affiliatePayment.count({ where: { orgId, externalPaymentRef: ref(5) } })).toBe(0);

  // Changing a column invalidates the preview: import is offered only after a fresh one.
  await page.getByTestId('invoice-column-transactions').selectOption('');
  await expect(page.getByTestId('invoice-import')).toBeDisabled();
  await page.getByTestId('invoice-preview').click();
  await expect(page.getByTestId('invoice-import')).toBeEnabled();
  await page.getByTestId('invoice-import').click();
  await expect(page.getByTestId('invoice-report-title')).toContainText('Imported');
  await expect.poll(() => prisma.affiliatePayment.count({ where: { orgId, externalPaymentRef: ref(5), source: 'INVOICE' } })).toBe(1);
});
