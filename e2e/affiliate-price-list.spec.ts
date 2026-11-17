import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * The transaction price list (#3843, src/lib/affiliatePriceListRule.ts): the
 * admin sets it on the settings page, sees live what a few counts cost, and the
 * server refuses a malformed list with its fields. A customer is marked as
 * reverse charge from the payments list. The pricing arithmetic itself is pinned
 * by scripts/test/affiliate-price-list-rule.test.mjs.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org and an invented price list.
 */

const PW = 'AffPrice123!';
const host = asHost(MARKETING_HOST);
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PLAN = {
  currency: 'EUR',
  tiers: [],
  topCommissionMinor: 2_000,
  percentBps: 1_000,
  switchAtCustomer: null,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};
// 5 free, a 5.00 base fee for the first 6, 0.10 up to 50, then 0.025; 20 % VAT.
const LIST = {
  freeUpTo: 5,
  baseCovers: 6,
  baseFeeMilli: 500_000,
  steps: [
    { upTo: 50, unitMilli: 10_000 },
    { upTo: null, unitMilli: 2_500 },
  ],
  vatBps: 2_000,
  reverseChargeAddsVat: false,
};

let orgId = '';
let partnerId = '';
let email = '';
let api: APIRequestContext;

const putList = (priceList: unknown) => api.put('/api/admin/affiliate/settings/price-list', { headers: host, data: { priceList } });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales Price ${STAMP}`, slug: `aff-price-${STAMP}`, vertical: 'MARKETING' } })).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: `price-${STAMP}`, displayName: 'Price Partner' } })).id;
  email = uniqueEmail('aff-price-admin');
  await seedUser(email, PW, 'ADMIN', 'Price Admin', { orgId });
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
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the API stores a valid list, refuses a malformed one with its fields, and removes it', async () => {
  const bad = await putList({ ...LIST, baseCovers: 5, steps: [{ upTo: 3, unitMilli: 1 }, { upTo: null, unitMilli: 1 }] });
  expect(bad.status()).toBe(400);
  const fields = ((await bad.json()).issues as { field: string }[]).map((i) => i.field).sort();
  expect(fields).toEqual(['baseCovers', 'steps.0.upTo']);

  const ok = await putList(LIST);
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toMatchObject({ ok: true, changed: true });
  expect((await putList(LIST)).ok()).toBe(true);
  expect((await (await putList(LIST)).json()).changed).toBe(false);
  const audits = await prisma.auditLog.count({ where: { orgId, action: 'affiliate.price_list.update' } });
  expect(audits).toBe(1);

  const settings = await (await api.get('/api/admin/affiliate/settings', { headers: host })).json();
  expect(settings.priceList).toEqual(LIST);
  // Not part of the plan: the version did not move.
  expect(settings.planVersion).toBe(1);

  expect((await putList(null)).ok()).toBe(true);
  expect((await (await api.get('/api/admin/affiliate/settings', { headers: host })).json()).priceList).toBeNull();
});

test('the settings form saves a list and shows what a few counts cost', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, email, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/settings');
  await expect(page.getByTestId('affiliate-price-list-none')).toBeVisible();

  await page.getByTestId('affiliate-price-free-up-to').fill('5');
  await page.getByTestId('affiliate-price-base-covers').fill('6');
  await page.getByTestId('affiliate-price-base-fee').fill('5,00');
  await page.getByTestId('affiliate-price-step-add').click();
  await page.getByTestId('affiliate-price-step-up-to-0').fill('50');
  await page.getByTestId('affiliate-price-step-unit-0').fill('0,10');
  await page.getByTestId('affiliate-price-step-unit-1').fill('0,025');
  await page.getByTestId('affiliate-price-vat').fill('20');

  // 51 transactions: 5,00 + 44 × 0,10 + 0,025 = 9,425 → net 9,43, gross 11,31.
  const row = page.getByTestId('affiliate-price-example-51');
  await expect(row).toContainText(/9[.,]43/);
  await expect(row).toContainText(/11[.,]31/);

  await page.getByTestId('affiliate-save-price-list').click();
  await expect.poll(async () => (await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } })).priceList).toEqual({
    ...LIST,
    reverseChargeAddsVat: true,
  });
  await expect(page.getByTestId('affiliate-price-list-none')).toHaveCount(0);
});

test('a customer is marked as reverse charge from the payments list', async ({ page }) => {
  const customer = await prisma.affiliateCustomer.create({ data: { orgId, partnerId, externalRef: `RC-${STAMP}` } });
  await prisma.affiliatePayment.create({
    data: { orgId, customerId: customer.id, amountMinor: 1_000, currency: 'EUR', receivedAt: new Date('2026-03-02T00:00:00Z'), externalPaymentRef: `RC-P-${STAMP}` },
  });

  // The API refuses a non-boolean and answers 404 for an unknown id.
  expect((await api.patch(`/api/admin/affiliate/customers/${customer.id}`, { headers: host, data: { reverseCharge: 'yes' } })).status()).toBe(400);
  expect((await api.patch('/api/admin/affiliate/customers/nope', { headers: host, data: { reverseCharge: true } })).status()).toBe(404);

  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, email, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/payments');
  await expect(page.getByTestId('affiliate-customer-reverse-charge-badge')).toHaveCount(0);
  await page.getByTestId('affiliate-customer-label-edit').first().click();
  await page.getByTestId('affiliate-customer-reverse-charge').check();
  await page.getByTestId('confirm-dialog-confirm').click();
  await expect(page.getByTestId('affiliate-customer-reverse-charge-badge')).toBeVisible();
  expect((await prisma.affiliateCustomer.findUniqueOrThrow({ where: { id: customer.id } })).reverseCharge).toBe(true);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.customer.reverse_charge' } })).toBe(1);
});
