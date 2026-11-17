import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * Month-aligned commission plans (#3845, src/lib/affiliateCommissionRule.ts):
 * the percent phase starts at the beginning of the month the switch customer
 * first paid in, earlier customers keep their one-off commission, and a
 * list-priced count (#3844) stores its list price, which picks the tier. The
 * date arithmetic itself is pinned by scripts/test/affiliate-commission-rule.test.mjs.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org, invented references and prices.
 */

const PW = 'AffMonth123!';
const host = asHost(MARKETING_HOST);
const STAMP = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
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
// 5 free, 5.00 base for the first 6, then 0.10; no VAT — keeps the numbers readable.
const PRICE_LIST = { freeUpTo: 5, baseCovers: 6, baseFeeMilli: 500_000, steps: [{ upTo: null, unitMilli: 10_000 }], vatBps: 0, reverseChargeAddsVat: true };

let orgId = '';
let partnerId = '';
let email = '';
let api: APIRequestContext;

const pay = (data: Record<string, unknown>) => api.post('/api/admin/affiliate/payments', { headers: host, data: { partnerId, ...data } });
const commissionOf = async (ref: string) => {
  const p = await prisma.affiliatePayment.findFirstOrThrow({ where: { orgId, externalPaymentRef: ref }, select: { commission: { select: { kind: true, amountMinor: true } } } });
  return p.commission ? `${p.commission.kind}:${p.commission.amountMinor}` : 'none';
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright, baseURL }) => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales Month ${STAMP}`, slug: `aff-month-${STAMP}`, vertical: 'MARKETING' } })).id;
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: `month-${STAMP}`, displayName: 'Month Partner' } })).id;
  email = uniqueEmail('aff-month-admin');
  await seedUser(email, PW, 'ADMIN', 'Month Admin', { orgId });
  api = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(api, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
});

test.afterAll(async () => {
  await api?.dispose();
  if (orgId) {
    const where = { orgId };
    await prisma.job.deleteMany({ where }).catch(() => {});
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

test('the plan form saves month alignment and its zone; a bad zone is refused', async ({ page }) => {
  const bad = await api.put('/api/admin/affiliate/settings/plan', { headers: host, data: { ...PLAN, timeZone: 'Mars/Olympus' } });
  expect(bad.status()).toBe(400);
  expect(JSON.stringify(await bad.json())).toContain('timeZone');

  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, email, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/settings');
  // A new plan is month-aligned in Berlin time by default.
  await expect(page.getByTestId('affiliate-plan-month-aligned')).toBeChecked();
  await expect(page.getByTestId('affiliate-plan-time-zone')).toHaveValue('Europe/Berlin');

  // Saved through the API (the form's other fields are pinned by affiliate-admin-settings).
  expect((await api.put('/api/admin/affiliate/settings/plan', { headers: host, data: PLAN })).status()).toBe(200);
  const stored = await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } });
  expect(stored.plan).toMatchObject({ monthAligned: true, timeZone: 'Europe/Berlin' });
  await gotoSettled(page, '/admin/affiliates/settings');
  await expect(page.getByTestId('affiliate-plan-month-aligned')).toBeChecked();
  await page.getByTestId('affiliate-plan-month-aligned').uncheck();
  await page.getByTestId('affiliate-save-plan').click();
  await expect.poll(async () => ((await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { orgId } })).plan as { monthAligned: boolean }).monthAligned).toBe(false);
  expect((await api.put('/api/admin/affiliate/settings/plan', { headers: host, data: PLAN })).status()).toBe(200);
});

test('the tier follows the list price; the percent starts at the beginning of the switch month', async () => {
  expect((await api.put('/api/admin/affiliate/settings/price-list', { headers: host, data: { priceList: PRICE_LIST } })).status()).toBe(200);

  // 1st customer, January, by count: 20 → 6.40 list = paid; band ≤ 10.00 → 3.00.
  expect((await pay({ customerExternalRef: `A-${STAMP}`, transactionCount: 20, receivedOn: '2026-01-10', externalPaymentRef: `A1-${STAMP}` })).status()).toBe(201);
  const a1 = await prisma.affiliatePayment.findFirstOrThrow({ where: { orgId, externalPaymentRef: `A1-${STAMP}` } });
  expect({ amountMinor: a1.amountMinor, listAmountMinor: a1.listAmountMinor, transactionCount: a1.transactionCount }).toEqual({ amountMinor: 640, listAmountMinor: 640, transactionCount: 20 });
  expect(await commissionOf(`A1-${STAMP}`)).toBe('TIER:300');

  // 2nd customer, March (the switch month), by count: 200 → 24.40 → top band 9.00.
  expect((await pay({ customerExternalRef: `B-${STAMP}`, transactionCount: 200, receivedOn: '2026-03-03', externalPaymentRef: `B1-${STAMP}` })).status()).toBe(201);
  // 1st customer pays again in February (before the switch month) and March (inside it).
  expect((await pay({ customerExternalRef: `A-${STAMP}`, amountMinor: 1_000, receivedOn: '2026-02-10', externalPaymentRef: `A2-${STAMP}` })).status()).toBe(201);
  expect((await pay({ customerExternalRef: `A-${STAMP}`, amountMinor: 2_000, receivedOn: '2026-03-05', externalPaymentRef: `A3-${STAMP}` })).status()).toBe(201);
  expect(await commissionOf(`A3-${STAMP}`)).toBe('none');

  // The 3rd customer first pays on 20 March: the percent phase starts on 1 March.
  expect((await pay({ customerExternalRef: `C-${STAMP}`, amountMinor: 3_000, receivedOn: '2026-03-20', externalPaymentRef: `C1-${STAMP}` })).status()).toBe(201);
  expect(await commissionOf(`B1-${STAMP}`)).toBe('TIER:900'); // same month, before the 3rd: keeps its one-off only
  expect(await commissionOf(`A2-${STAMP}`)).toBe('none'); // February: before the switch month
  expect(await commissionOf(`A3-${STAMP}`)).toBe('PERCENT:200'); // March, before the 3rd customer: now percent
  expect(await commissionOf(`C1-${STAMP}`)).toBe('PERCENT:300');
});
