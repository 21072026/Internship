import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * The commission base on the admin's payment entry (#3553, docs/affiliate-module.md
 * § Commission base): the API and the form take the base either as transactions ×
 * the undiscounted unit price or as the amount itself; the writer's
 * resolvePaymentBase() decides, so disagreeing shapes are refused with their
 * issue and write nothing. A client that sends only `amountMinor` keeps working.
 * The account event and the migration CSV are pinned in their own specs.
 * The breakdown is shown beside the base (#3554): in the admin's payment list and
 * on the partner's own commissions page; a payment without one shows the amount only.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org, invented references, EUR plan.
 */

const PW = 'AffBase123!';
const host = asHost(MARKETING_HOST);
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 100_000, commissionMinor: 2_500 }],
  topCommissionMinor: 5_000,
  percentBps: 1_000,
  switchAtCustomer: null,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

let orgId = '';
let partnerId = '';
let email = '';
let partnerEmail = '';
let api: APIRequestContext;

const stored = (ref: string) =>
  prisma.affiliatePayment.findFirstOrThrow({ where: { orgId, externalPaymentRef: ref }, select: { amountMinor: true, transactionCount: true, unitPriceMinor: true } });
const pay = (data: Record<string, unknown>) =>
  api.post('/api/admin/affiliate/payments', { headers: host, data: { partnerId, customerExternalRef: 'CUST-BASE', receivedOn: '2026-03-02', ...data } });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales Base ${STAMP}`, slug: `aff-base-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: `base-${STAMP}`, displayName: 'Base Partner' } })).id;
  email = uniqueEmail('aff-base-admin');
  await seedUser(email, PW, 'ADMIN', 'Base Admin', { orgId });
  partnerEmail = uniqueEmail('aff-base-partner');
  const partnerUser = await seedUser(partnerEmail, PW, 'AFFILIATE', 'Base Partner', { orgId });
  await prisma.affiliatePartner.update({ where: { id: partnerId }, data: { userId: partnerUser.id } });
  api = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(api, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
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
  if (partnerEmail) await cleanupByEmail(partnerEmail);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the API takes the base as transactions × price, as an amount, or both when they agree', async () => {
  // 340 × 0,15 € = 51,00 €, stored with its breakdown.
  expect((await pay({ transactionCount: 340, unitPriceMinor: 15, externalPaymentRef: `B1-${STAMP}` })).status()).toBe(201);
  expect(await stored(`B1-${STAMP}`)).toEqual({ amountMinor: 5_100, transactionCount: 340, unitPriceMinor: 15 });

  expect((await pay({ amountMinor: 5_100, transactionCount: 340, unitPriceMinor: 15, externalPaymentRef: `B2-${STAMP}` })).status()).toBe(201);
  // An older client that sends only the amount still works; no breakdown is kept.
  expect((await pay({ amountMinor: 4_990, externalPaymentRef: `B3-${STAMP}` })).status()).toBe(201);
  expect(await stored(`B3-${STAMP}`)).toEqual({ amountMinor: 4_990, transactionCount: null, unitPriceMinor: null });

  // Refusals name their issue and write nothing.
  const before = await prisma.affiliatePayment.count({ where: { orgId } });
  for (const [data, issue] of [
    [{ amountMinor: 5_000, transactionCount: 340, unitPriceMinor: 15 }, 'amount_mismatch'],
    // A count alone is priced by the price list (#3844); none is set here.
    [{ transactionCount: 340 }, 'no_price_list'],
    [{ unitPriceMinor: 15 }, 'incomplete_breakdown'],
    [{}, 'amount_required'],
  ] as const) {
    const res = await pay({ ...data, externalPaymentRef: `BX-${issue}-${STAMP}` });
    expect(res.status(), issue).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_input', issues: [issue] });
  }
  expect(await prisma.affiliatePayment.count({ where: { orgId } })).toBe(before);
});

test('the breakdown shows beside the base: in the admin list and on the partner’s commissions (#3554)', async ({ browser, baseURL }) => {
  test.slow();
  const admin = await browser.newPage({ baseURL, extraHTTPHeaders: host });
  await signInAndSettle(admin, email, PW, '/admin');
  await gotoSettled(admin, '/admin/affiliates/payments');
  const rowOf = (ref: string) => admin.locator('tr', { hasText: ref });
  await expect(rowOf(`B1-${STAMP}`).getByTestId('affiliate-payment-breakdown')).toHaveText('340 transactions × €0.15');
  await expect(rowOf(`B3-${STAMP}`)).toContainText('€49.90');
  await expect(rowOf(`B3-${STAMP}`).getByTestId('affiliate-payment-breakdown')).toHaveCount(0);
  await admin.close();

  // The partner sees the same line on its own commissions. The plan pays one tier commission per
  // customer (on B1, entered as a breakdown); a second customer paid as a bare amount shows none.
  expect((await pay({ customerExternalRef: 'CUST-PLAIN', amountMinor: 2_000, externalPaymentRef: `P1-${STAMP}` })).status()).toBe(201);
  const partner = await browser.newPage({ baseURL, extraHTTPHeaders: host });
  await signInAndSettle(partner, partnerEmail, PW, '/affiliate');
  await gotoSettled(partner, '/affiliate/commissions');
  await expect(partner.getByTestId('affiliate-commissions-table').locator('tbody tr')).toHaveCount(2);
  await expect(partner.getByTestId('affiliate-commission-breakdown')).toHaveCount(1);
  await expect(partner.locator('tbody tr', { hasText: 'CUST-BASE' }).getByTestId('affiliate-commission-breakdown')).toHaveText('340 transactions × €0.15');
  await partner.close();
});

// Synthetic (#3844): 5 free, a 5.00 base fee for the first 6, then 0.10; 20 % VAT,
// none on a reverse-charge customer.
const PRICE_LIST = {
  freeUpTo: 5,
  baseCovers: 6,
  baseFeeMilli: 500_000,
  steps: [{ upTo: null, unitMilli: 10_000 }],
  vatBps: 2_000,
  reverseChargeAddsVat: false,
};
const setPriceList = (priceList: unknown) => api.put('/api/admin/affiliate/settings/price-list', { headers: host, data: { priceList } });

test('a count alone is priced by the price list; without one, or within the free limit, it is refused (#3844)', async () => {
  expect(await (await pay({ transactionCount: 20, externalPaymentRef: `L0-${STAMP}` })).json()).toEqual({ code: 'invalid_input', issues: ['no_price_list'] });
  expect((await setPriceList(PRICE_LIST)).status()).toBe(200);
  try {
    expect(await (await pay({ transactionCount: 5, externalPaymentRef: `L1-${STAMP}` })).json()).toEqual({ code: 'invalid_input', issues: ['free_month'] });
    // 20 transactions: 5.00 + 14 × 0.10 = 6.40 net, 7.68 gross.
    expect((await pay({ transactionCount: 20, externalPaymentRef: `L2-${STAMP}` })).status()).toBe(201);
    expect(await stored(`L2-${STAMP}`)).toEqual({ amountMinor: 768, transactionCount: 20, unitPriceMinor: null });

    // A reverse-charge customer gets no VAT under this list.
    await prisma.affiliateCustomer.create({ data: { orgId, partnerId, externalRef: `RC-${STAMP}`, reverseCharge: true } });
    expect((await pay({ customerExternalRef: `RC-${STAMP}`, transactionCount: 20, externalPaymentRef: `L3-${STAMP}` })).status()).toBe(201);
    expect(await stored(`L3-${STAMP}`)).toEqual({ amountMinor: 640, transactionCount: 20, unitPriceMinor: null });

    // An empty reference becomes <customer number>-YYYY-MM; a second entry for the month is a duplicate.
    const first = await pay({ customerExternalRef: `REF-${STAMP}`, transactionCount: 20, externalPaymentRef: '  ', receivedOn: '2026-02-14' });
    expect(first.status()).toBe(201);
    expect((await first.json()).externalPaymentRef).toBe(`REF-${STAMP}-2026-02`);
    const again = await pay({ customerExternalRef: `REF-${STAMP}`, transactionCount: 30, externalPaymentRef: '', receivedOn: '2026-02-20' });
    expect(await again.json()).toMatchObject({ code: 'duplicate_payment' });
  } finally {
    expect((await setPriceList(null)).status()).toBe(200);
  }
});

test('the form: the amount only without a price list; with one, the count with a live price and a default reference', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, email, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/payments');

  // No price list: counting is off, the amount is the mode, and the screen says where to set one.
  await expect(page.getByTestId('affiliate-payment-mode-count')).toBeDisabled();
  await expect(page.getByTestId('affiliate-payment-mode-amount')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('affiliate-payment-no-price-list')).toBeVisible();
  await page.getByTestId('affiliate-payment-customer').fill('CUST-BASE');
  await page.getByTestId('affiliate-payment-amount').fill('49,90');
  await page.getByTestId('affiliate-payment-ref').fill(`F2-${STAMP}`);
  await page.getByTestId('affiliate-payment-save').click();
  await expect.poll(() => prisma.affiliatePayment.count({ where: { orgId, externalPaymentRef: `F2-${STAMP}` } })).toBe(1);
  expect(await stored(`F2-${STAMP}`)).toEqual({ amountMinor: 4_990, transactionCount: null, unitPriceMinor: null });

  expect((await setPriceList(PRICE_LIST)).status()).toBe(200);
  try {
    await gotoSettled(page, '/admin/affiliates/payments');
    await expect(page.getByTestId('affiliate-payment-mode-count')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('affiliate-payment-base-hint')).toContainText('Gross, VAT included');
    // A new customer number needs its partner.
    await page.getByTestId('affiliate-payment-partner').selectOption(partnerId);
    await page.getByTestId('affiliate-payment-customer').fill(`FORM-${STAMP}`);
    await page.getByTestId('affiliate-payment-count').fill('3');
    await expect(page.getByTestId('affiliate-payment-count-preview')).toContainText('not a payment');
    await page.getByTestId('affiliate-payment-count').fill('20');
    // Gross, and the reverse-charge price beside it since this list adds no VAT there.
    await expect(page.getByTestId('affiliate-payment-count-preview')).toHaveText('20 transactions → €7.68 by the price list · reverse-charge customer: €6.40');
    await page.getByTestId('affiliate-payment-date').fill('2026-03-02');
    await expect(page.getByTestId('affiliate-payment-ref')).toHaveAttribute('placeholder', `FORM-${STAMP}-2026-03`);
    await page.getByTestId('affiliate-payment-save').click();
    await expect.poll(() => prisma.affiliatePayment.count({ where: { orgId, externalPaymentRef: `FORM-${STAMP}-2026-03` } })).toBe(1);
    expect(await stored(`FORM-${STAMP}-2026-03`)).toEqual({ amountMinor: 768, transactionCount: 20, unitPriceMinor: null });
    // The list says where the amount came from.
    await expect(page.getByTestId('affiliate-payment-breakdown').filter({ hasText: 'price list' }).first()).toHaveText('20 transactions · price list');
  } finally {
    expect((await setPriceList(null)).status()).toBe(200);
  }
});
