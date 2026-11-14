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
    [{ transactionCount: 340 }, 'incomplete_breakdown'],
    [{}, 'amount_required'],
  ] as const) {
    const res = await pay({ ...data, externalPaymentRef: `BX-${issue}-${STAMP}` });
    expect(res.status(), issue).toBe(400);
    expect(await res.json()).toEqual({ code: 'invalid_input', issues: [issue] });
  }
  expect(await prisma.affiliatePayment.count({ where: { orgId } })).toBe(before);
});

test('the form records transactions × price with a live product, or the base amount', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, email, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/payments');

  // Transactions × price is the default; the product shows before saving.
  await expect(page.getByTestId('affiliate-payment-mode-breakdown')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('affiliate-payment-base-hint')).toContainText('Undiscounted, gross, VAT included');
  await page.getByTestId('affiliate-payment-customer').fill('CUST-BASE');
  await page.getByTestId('affiliate-payment-count').fill('340');
  await page.getByTestId('affiliate-payment-unit-price').fill('0,15');
  await expect(page.getByTestId('affiliate-payment-breakdown-preview')).toHaveText(/^340 × €0\.15 = €51\.00$/);
  await page.getByTestId('affiliate-payment-ref').fill(`F1-${STAMP}`);
  await page.getByTestId('affiliate-payment-save').click();
  await expect.poll(() => prisma.affiliatePayment.count({ where: { orgId, externalPaymentRef: `F1-${STAMP}` } })).toBe(1);
  expect(await stored(`F1-${STAMP}`)).toEqual({ amountMinor: 5_100, transactionCount: 340, unitPriceMinor: 15 });

  // The base amount, as before.
  await page.getByTestId('affiliate-payment-mode-amount').click();
  await page.getByTestId('affiliate-payment-customer').fill('CUST-BASE');
  await page.getByTestId('affiliate-payment-amount').fill('49,90');
  await page.getByTestId('affiliate-payment-ref').fill(`F2-${STAMP}`);
  await page.getByTestId('affiliate-payment-save').click();
  await expect.poll(() => prisma.affiliatePayment.count({ where: { orgId, externalPaymentRef: `F2-${STAMP}` } })).toBe(1);
  expect(await stored(`F2-${STAMP}`)).toEqual({ amountMinor: 4_990, transactionCount: null, unitPriceMinor: null });
});
