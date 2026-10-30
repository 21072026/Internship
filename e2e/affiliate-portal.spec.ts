import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * The partner portal (docs/affiliate-module.md, #3117).
 *
 * A partner reads its own referral link, totals, customers, commissions and
 * payouts — and nothing of another partner's: another partner's payout page is
 * 404, like one that does not exist. Bank details are entered in the portal and
 * shown masked. The referral base URL is the admin's setting, validated.
 * @smoke: a data-isolation boundary.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run, example hosts, XTS-free EUR amounts.
 */

const PW = 'AffPortal123!';
const host = asHost(MARKETING_HOST);
let orgId = '';
let adminEmail = '';
let mineEmail = '';
let theirsEmail = '';
const ids = { mine: '', theirs: '', myPayout: '', theirPayout: '' };
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

/** A customer with one paid payment and its commission, inside a payout. */
async function seedPartnerData(partnerId: string, ref: string, paymentMinor: number, commissionMinor: number) {
  const customer = await prisma.affiliateCustomer.create({ data: { orgId, partnerId, externalRef: ref } });
  const receivedAt = new Date('2026-03-02T00:00:00Z');
  const payment = await prisma.affiliatePayment.create({
    data: { orgId, customerId: customer.id, amountMinor: paymentMinor, currency: 'EUR', receivedAt, externalPaymentRef: `${ref}-INV-SECRET` },
  });
  const payout = await prisma.affiliatePayout.create({
    data: { orgId, partnerId, amountMinor: commissionMinor, currency: 'EUR', paidAt: new Date('2026-04-15T00:00:00Z'), reference: `TRX-${ref}` },
  });
  await prisma.affiliateCommission.create({
    data: {
      orgId,
      partnerId,
      customerId: customer.id,
      paymentId: payment.id,
      kind: 'TIER',
      amountMinor: commissionMinor,
      currency: 'EUR',
      accruedAt: receivedAt,
      dueAt: new Date('2026-04-01T00:00:00Z'),
      planVersion: 1,
      status: 'PAID',
      payoutId: payout.id,
      paidAt: payout.paidAt,
    },
  });
  return payout.id;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-portal-${stamp}`, vertical: 'MARKETING' } })).id;
  adminEmail = uniqueEmail('aff-portal-admin');
  mineEmail = uniqueEmail('aff-portal-mine');
  theirsEmail = uniqueEmail('aff-portal-theirs');
  await seedUser(adminEmail, PW, 'ADMIN', 'Portal Admin', { orgId });
  const mineUser = await seedUser(mineEmail, PW, 'AFFILIATE', 'Mine Partner', { orgId });
  const theirsUser = await seedUser(theirsEmail, PW, 'AFFILIATE', 'Their Partner', { orgId });
  ids.mine = (await prisma.affiliatePartner.create({ data: { orgId, userId: mineUser.id, code: 'mine-7', displayName: 'Mine' } })).id;
  ids.theirs = (await prisma.affiliatePartner.create({ data: { orgId, userId: theirsUser.id, code: 'theirs-9', displayName: 'Theirs' } })).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, contract: { en: 'Synthetic terms' }, contractVersion: 1 } });
  await prisma.affiliateContractAcceptance.createMany({
    data: [
      { orgId, partnerId: ids.mine, version: 1 },
      { orgId, partnerId: ids.theirs, version: 1 },
    ],
  });
  ids.myPayout = await seedPartnerData(ids.mine, 'CUST-MINE', 10_000, 2_500);
  ids.theirPayout = await seedPartnerData(ids.theirs, 'CUST-THEIRS', 20_000, 7_700);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (orgId) {
    await prisma.affiliateCommission.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePayout.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateContractAcceptance.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  }
  for (const e of [adminEmail, mineEmail, theirsEmail]) if (e) await cleanupByEmail(e);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the referral base URL is validated, stored and audited', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL });
  contexts.push(admin);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const put = (referralUrl: unknown) => admin.put('/api/admin/affiliate/settings/referral-url', { headers: host, data: { referralUrl } });

  for (const [url, issue] of [
    ['http://shop.example/', 'not_https'],
    ['https://shop.example/?ref=x', 'has_ref'],
    ['javascript:alert(1)', 'not_https'],
  ] as const) {
    const res = await put(url);
    expect(res.status(), url).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_referral_url', issue });
  }
  // A body without the key is refused, never read as "clear".
  expect((await admin.put('/api/admin/affiliate/settings/referral-url', { headers: host, data: {} })).status()).toBe(400);
  const saved = await put(' https://shop.example/start ');
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ referralUrl: 'https://shop.example/start', changed: true });
  expect((await (await put('https://shop.example/start')).json()).changed).toBe(false);
  expect((await admin.put('/api/admin/affiliate/settings/referral-url', { headers: host, data: {} })).status()).toBe(400);
  expect((await prisma.affiliateProgramSettings.findUnique({ where: { orgId } }))?.referralUrl).toBe('https://shop.example/start');
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.referral_url.update' } })).toBe(1);

  // A partner cannot write it.
  const partner = await playwright.request.newContext({ baseURL });
  contexts.push(partner);
  expect((await signInViaApi(partner, mineEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  expect((await partner.put('/api/admin/affiliate/settings/referral-url', { headers: host, data: { referralUrl: null } })).status()).toBe(403);
});

test('a partner sees its own rows only; another partner’s payout is 404', { tag: '@smoke' }, async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mineEmail, PW, '/affiliate');

  await expect(page.getByTestId('affiliate-referral-link')).toHaveText('https://shop.example/start?ref=mine-7');
  await expect(page.getByTestId('affiliate-total-customers')).toContainText('1');
  await expect(page.getByTestId('affiliate-total-PAID')).toContainText('25');

  await gotoSettled(page, '/affiliate/customers');
  const customers = page.getByTestId('affiliate-customers-table');
  await expect(customers).toContainText('CUST-MINE');
  await expect(customers).not.toContainText('CUST-THEIRS');

  await gotoSettled(page, '/affiliate/commissions');
  const commissions = page.getByTestId('affiliate-commissions-table');
  await expect(commissions).toContainText('CUST-MINE');
  await expect(commissions).not.toContainText('CUST-THEIRS');
  // The payment's own reference stays on the admin side.
  await expect(page.locator('body')).not.toContainText('INV-SECRET');

  await gotoSettled(page, '/affiliate/payouts');
  await expect(page.getByTestId('affiliate-payouts-table')).toContainText('TRX-CUST-MINE');
  await expect(page.getByTestId('affiliate-payouts-table')).not.toContainText('TRX-CUST-THEIRS');

  const mine = await page.goto(`/affiliate/payouts/${ids.myPayout}`);
  expect(mine?.status()).toBe(200);
  await expect(page.getByTestId('affiliate-payout-amount')).toContainText('25');
  const theirs = await page.goto(`/affiliate/payouts/${ids.theirPayout}`);
  expect(theirs?.status()).toBe(404);
  await expect(page.locator('body')).not.toContainText('TRX-CUST-THEIRS');
});

test('bank details are entered in the portal and shown masked', { tag: '@smoke' }, async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mineEmail, PW, '/affiliate');
  await gotoSettled(page, '/affiliate/payout-details');

  await page.getByTestId('affiliate-iban').fill('DE89 3704 0044 0532 0130 00');
  await page.getByTestId('affiliate-holder').fill('Mine Partner');
  await page.getByTestId('affiliate-save-details').click();
  await expect(page.getByTestId('affiliate-payout-current')).toContainText('3000', { timeout: 20_000 });
  await expect(page.getByTestId('affiliate-payout-current')).not.toContainText('370400440532');
  await expect(page.getByTestId('affiliate-iban')).toHaveValue('');
});

// #3349: the partner reads its own organisation's current plan — read-only, behind the contract gate.
const plan = (topCommissionMinor: number, upToMinor: number, commissionMinor: number) => ({
  currency: 'EUR',
  tiers: [{ upToMinor, commissionMinor }],
  topCommissionMinor,
  percentBps: 850,
  switchAtCustomer: 7,
  boundaryCustomer: 'PERCENT',
  windowMonths: 12,
  payoutDays: 30,
  afterNotice: 'RUN_OUT',
});

test('the portal home shows the commission terms of the partner’s own org only, read-only', { tag: '@smoke' }, async ({ page }) => {
  // Another organisation with its own, different plan: it must never show here.
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const other = await prisma.organization.create({ data: { name: `Beta Sales ${stamp}`, slug: `aff-terms-${stamp}`, vertical: 'MARKETING' } });
  await prisma.affiliateProgramSettings.create({
    data: { orgId: other.id, plan: plan(6_300, 30_000, 5_500), planVersion: 4, planEffectiveAt: new Date('2026-05-05T00:00:00Z') },
  });
  try {
    await prisma.affiliateProgramSettings.update({
      where: { orgId },
      data: { plan: plan(9_100, 20_000, 4_700), planVersion: 2, planEffectiveAt: new Date('2026-03-01T00:00:00Z') },
    });

    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, mineEmail, PW, '/affiliate');
    const terms = page.getByTestId('affiliate-terms');
    await expect(terms).toBeVisible();
    await expect(page.getByTestId('affiliate-terms-bands')).toContainText(/47[.,]00/);
    await expect(page.getByTestId('affiliate-terms-bands')).toContainText(/91[.,]00/);
    await expect(page.getByTestId('affiliate-terms-percent')).toContainText(/8[.,]5/);
    await expect(page.getByTestId('affiliate-terms-version')).toContainText('2');
    await expect(terms).not.toContainText(/63[.,]00|55[.,]00/);
    // Read-only: no form control inside the box.
    await expect(terms.locator('input, textarea, select, button')).toHaveCount(0);
  } finally {
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: other.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: other.id } }).catch(() => {});
    await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: Prisma.DbNull, planVersion: 0, planEffectiveAt: null } }).catch(() => {});
  }
});

test('a plan change shows as the new version, and a partner who has not accepted the contract sees no terms', async ({ page }) => {
  const lateEmail = uniqueEmail('aff-portal-late');
  let lateUserId = '';
  try {
    await prisma.affiliateProgramSettings.update({
      where: { orgId },
      data: { plan: plan(9_100, 20_000, 4_700), planVersion: 2, planEffectiveAt: new Date('2026-03-01T00:00:00Z') },
    });
    await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
    await signInAndSettle(page, mineEmail, PW, '/affiliate');
    await expect(page.getByTestId('affiliate-terms-version')).toContainText('2');

    // A plan change shows as the new version.
    await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: plan(9_100, 20_000, 5_200), planVersion: 3, planEffectiveAt: new Date('2026-04-01T00:00:00Z') } });
    await gotoSettled(page, '/affiliate');
    await expect(page.getByTestId('affiliate-terms-bands')).toContainText(/52[.,]00/);
    await expect(page.getByTestId('affiliate-terms-version')).toContainText('3');

    // A partner who has not accepted the current contract is sent to it, and sees no terms.
    const late = await seedUser(lateEmail, PW, 'AFFILIATE', 'Late Partner', { orgId });
    lateUserId = late.id;
    await prisma.affiliatePartner.create({ data: { orgId, userId: late.id, code: 'late-3', displayName: 'Late' } });
    await page.context().clearCookies();
    await signInAndSettle(page, lateEmail, PW, '/affiliate');
    await expect(page).toHaveURL(/\/affiliate\/contract/);
    await expect(page.getByTestId('affiliate-terms')).toHaveCount(0);
  } finally {
    await prisma.affiliatePartner.deleteMany({ where: { orgId, userId: lateUserId || 'none' } }).catch(() => {});
    await cleanupByEmail(lateEmail);
    await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: Prisma.DbNull, planVersion: 0, planEffectiveAt: null } }).catch(() => {});
  }
});

// #3348: the partner can see why a commission has its amount — the kind and the plan version.
test('the commissions table shows the kind and plan version, but no version for an imported row', async ({ page }) => {
  // An imported row (plan version 0) of the same partner: the kind shows, the version does not.
  const customer = await prisma.affiliateCustomer.create({ data: { orgId, partnerId: ids.mine, externalRef: 'CUST-OLD' } });
  const receivedAt = new Date('2026-01-05T00:00:00Z');
  const payment = await prisma.affiliatePayment.create({
    data: { orgId, customerId: customer.id, amountMinor: 5_000, currency: 'EUR', receivedAt, externalPaymentRef: 'CUST-OLD-INV-SECRET', source: 'IMPORT' },
  });
  await prisma.affiliateCommission.create({
    data: {
      orgId,
      partnerId: ids.mine,
      customerId: customer.id,
      paymentId: payment.id,
      kind: 'IMPORTED',
      amountMinor: 1_000,
      currency: 'EUR',
      accruedAt: receivedAt,
      dueAt: new Date('2026-02-01T00:00:00Z'),
      planVersion: 0,
      status: 'PENDING',
    },
  });

  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mineEmail, PW, '/affiliate');
  await gotoSettled(page, '/affiliate/commissions');
  const table = page.getByTestId('affiliate-commissions-table');
  const rows = table.locator('tbody tr');
  await expect(rows.filter({ hasText: 'CUST-MINE' }).getByTestId('affiliate-commission-kind')).toContainText(/\((v|s)1\)/);
  const imported = rows.filter({ hasText: 'CUST-OLD' }).getByTestId('affiliate-commission-kind');
  await expect(imported).toBeVisible();
  await expect(imported).not.toContainText(/\((v|s)\d+\)/);
  await expect(table).not.toContainText('CUST-THEIRS');
  await expect(page.locator('body')).not.toContainText('INV-SECRET');
});
