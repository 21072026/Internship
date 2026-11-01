import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

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
  // Support tickets go with their requester (onDelete: Cascade) in cleanupByEmail.
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

// #3353: "Ask" on a row opens the partner's support thread with the row attached.
// Only the partner's own row is accepted — another partner's id is 404, like one
// that does not exist — and the admin's inbox shows which row it is about. A
// question changes nothing. @smoke: a data-isolation boundary on a write path.
test('a partner asks about its own row through support; another partner’s row is refused', { tag: '@smoke' }, async ({ playwright, baseURL, page }) => {
  const partner = await playwright.request.newContext({ baseURL });
  contexts.push(partner);
  expect((await signInViaApi(partner, mineEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const mine = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId, partnerId: ids.mine, customer: { externalRef: 'CUST-MINE' } } });
  const theirs = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId, partnerId: ids.theirs } });
  const ask = (recordRef: string, label: string) =>
    partner.post('/api/support', { headers: { ...host, ...freshIp(`affiliate-ask ${label}`) }, data: { body: 'Why this amount?', recordRef } });

  for (const [ref, label] of [[`affiliate:commission:${theirs.id}`, 'theirs'], ['affiliate:commission:nope', 'unknown'], ['not-a-ref', 'garbage']]) {
    const res = await ask(ref, label);
    expect([res.status(), (await res.json()).code], label).toEqual([404, 'record_not_found']);
  }
  expect(await prisma.supportMessage.count({ where: { sender: { email: mineEmail } } })).toBe(0);

  // From the screen: Ask on the customers page, then send.
  await page.context().setExtraHTTPHeaders({ ...asHost(MARKETING_HOST), ...freshIp('affiliate-ask ui') });
  await signInAndSettle(page, mineEmail, PW, '/affiliate');
  await gotoSettled(page, '/affiliate/commissions');
  await page.getByTestId('affiliate-commissions-table').locator('tbody tr').filter({ hasText: 'CUST-MINE' }).getByTestId('affiliate-ask').click();
  await expect(page).toHaveURL(/\/affiliate\/support\?record=/);
  await expect(page.getByTestId('support-record')).toContainText('CUST-MINE');
  await page.getByTestId('support-input').fill('Is this commission final?');
  await page.getByTestId('support-send').click();
  // Sent: the draft's link is gone (no remove button) and the thread shows it on the message.
  await expect(page.getByTestId('support-record-remove')).toHaveCount(0);
  await expect(page.getByTestId('support-chat').getByTestId('support-record')).toContainText('CUST-MINE');
  await expect.poll(() => prisma.supportMessage.count({ where: { sender: { email: mineEmail } } })).toBe(1);
  const sent = await prisma.supportMessage.findFirstOrThrow({ where: { sender: { email: mineEmail } } });
  expect(sent.recordRef).toBe(`affiliate:commission:${mine.id}`);
  // Nothing moved: the commission is as it was.
  expect((await prisma.affiliateCommission.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe(mine.status);

  // The admin's inbox names the row.
  const admin = await playwright.request.newContext({ baseURL });
  contexts.push(admin);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const inbox = await (await admin.get('/api/admin/support', { headers: host })).json();
  const message = inbox.tickets.flatMap((t: { messages: { id: string }[] }) => t.messages).find((m: { id: string }) => m.id === sent.id);
  expect(message.record).toMatchObject({ kind: 'commission', customerRef: 'CUST-MINE', amountMinor: mine.amountMinor });
});

// #3352: the admin writes a label the partner recognises; the reference stays
// the key. Only a writing admin of the org sets it; the partner reads it on its
// own rows. A screen-and-write check, not a boundary of its own: no @smoke tag.
test('an admin-written customer label shows next to the reference in the portal', async ({ playwright, baseURL, page, browser }) => {
  const admin = await playwright.request.newContext({ baseURL });
  contexts.push(admin);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const partner = await playwright.request.newContext({ baseURL });
  contexts.push(partner);
  expect((await signInViaApi(partner, mineEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const customer = await prisma.affiliateCustomer.findFirstOrThrow({ where: { orgId, externalRef: 'CUST-MINE' } });
  const patch = (ctx: APIRequestContext, id: string, partnerLabel: unknown) =>
    ctx.patch(`/api/admin/affiliate/customers/${id}`, { headers: host, data: { partnerLabel } });

  expect((await patch(partner, customer.id, 'Acme Ltd')).status()).toBe(403);
  expect((await patch(admin, 'no-such-customer', 'Acme Ltd')).status()).toBe(404);
  expect((await patch(admin, customer.id, 'x'.repeat(81))).status()).toBe(400);
  expect(await (await patch(admin, customer.id, '  Acme   Ltd ')).json()).toEqual({ ok: true, partnerLabel: 'Acme Ltd' });
  expect((await prisma.affiliateCustomer.findUniqueOrThrow({ where: { id: customer.id } })).externalRef).toBe('CUST-MINE');
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.customer.label', targetId: customer.id } })).toBe(1);

  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mineEmail, PW, '/affiliate');
  for (const [path, table] of [['/affiliate/customers', 'affiliate-customers-table'], ['/affiliate/commissions', 'affiliate-commissions-table']]) {
    await gotoSettled(page, path);
    const row = page.getByTestId(table).locator('tbody tr').filter({ hasText: 'CUST-MINE' });
    await expect(row, path).toContainText('Acme Ltd');
  }
  await gotoSettled(page, `/affiliate/payouts/${ids.myPayout}`);
  await expect(page.locator('main')).toContainText('Acme Ltd');

  // Cleared from the admin's Payments screen: the reference alone again.
  const adminContext = await browser.newContext({ baseURL, extraHTTPHeaders: asHost(MARKETING_HOST) });
  const adminPage = await adminContext.newPage();
  await signInAndSettle(adminPage, adminEmail, PW, '/admin');
  await gotoSettled(adminPage, '/admin/affiliates/payments');
  const adminRow = adminPage.getByTestId('affiliate-payment-table').locator('tbody tr').filter({ hasText: 'CUST-MINE' });
  await expect(adminRow).toContainText('Acme Ltd');
  await adminRow.getByTestId('affiliate-customer-label-edit').click();
  await expect(adminPage.getByTestId('affiliate-customer-label-input')).toHaveValue('Acme Ltd');
  await adminPage.getByTestId('affiliate-customer-label-input').fill('');
  await adminPage.getByTestId('confirm-dialog-confirm').click();
  await expect(adminRow).not.toContainText('Acme Ltd');
  await adminContext.close();
  expect((await prisma.affiliateCustomer.findUniqueOrThrow({ where: { id: customer.id } })).partnerLabel).toBeNull();
  await gotoSettled(page, '/affiliate/customers');
  await expect(page.getByTestId('affiliate-customers-table')).not.toContainText('Acme Ltd');
});
