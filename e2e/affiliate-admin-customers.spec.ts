import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { customerWindowEndsAt } from '../src/lib/affiliateCommissionRule';

/**
 * The admin's customer list and the grouped tabs (#3538, docs/affiliate-module.md
 * "Admin screens").
 *
 * One row per referred customer of the org — its partner, first and last payment,
 * payment count, the commission window's end (the engine's, the same date the
 * partner portal shows) and the commission earned. Read-only and org-scoped: another
 * organisation's customers never appear, and asking for another organisation's
 * partner is a 404. The tabs come in two groups, Customers and Partners.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs, example labels, XTS amounts.
 */

const PW = 'AffCustomers123!';
const host = asHost(MARKETING_HOST);
const PLAN = {
  currency: 'XTS',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 1_000,
  switchAtCustomer: 1,
  boundaryCustomer: 'PERCENT',
  windowMonths: 6,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};
const FIRST = '2026-03-02';
const LAST = '2026-04-15';

const orgs = { mine: '', other: '' };
const emails = { admin: '', observer: '', otherAdmin: '' };
const partners = { alpha: '', beta: '', foreign: '' };
const customers: Record<string, string> = {};
const contexts: APIRequestContext[] = [];
const api: Record<string, APIRequestContext> = {};

test.describe.configure({ mode: 'serial' });

const list = (who: string, query = '') => api[who].get(`/api/admin/affiliate/customers${query}`, { headers: host });

test.beforeAll(async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  for (const k of ['mine', 'other'] as const) {
    orgs[k] = (await prisma.organization.create({ data: { name: `Acme Sales ${k} ${stamp}`, slug: `aff-cust-${k}-${stamp}`, vertical: 'MARKETING' } })).id;
    await prisma.affiliateProgramSettings.create({ data: { orgId: orgs[k], plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  }
  emails.admin = uniqueEmail('aff-cust-admin');
  emails.observer = uniqueEmail('aff-cust-observer');
  emails.otherAdmin = uniqueEmail('aff-cust-other');
  await seedUser(emails.admin, PW, 'ADMIN', 'Customers Admin', { orgId: orgs.mine });
  const observer = await seedUser(emails.observer, PW, 'ADMIN', 'Customers Observer', { orgId: orgs.mine });
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  await seedUser(emails.otherAdmin, PW, 'ADMIN', 'Other Admin', { orgId: orgs.other });

  partners.alpha = (await prisma.affiliatePartner.create({ data: { orgId: orgs.mine, code: `cust-alpha-${stamp}`, displayName: 'Alpha Partner' } })).id;
  partners.beta = (await prisma.affiliatePartner.create({ data: { orgId: orgs.mine, code: `cust-beta-${stamp}`, displayName: 'Beta Partner' } })).id;
  partners.foreign = (await prisma.affiliatePartner.create({ data: { orgId: orgs.other, code: `cust-foreign-${stamp}`, displayName: 'Foreign Partner' } })).id;

  for (const [who, email] of Object.entries(emails)) {
    const ctx = await playwright.request.newContext({ baseURL });
    contexts.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok, who).toBe(true);
    api[who] = ctx;
  }

  // Through the one writer, so the commissions are the engine's.
  const pay = async (who: string, partnerId: string, ref: string, receivedOn: string, n: number) => {
    const res = await api[who].post('/api/admin/affiliate/payments', {
      headers: host,
      data: { partnerId, customerExternalRef: ref, amountMinor: 5_000, receivedOn, externalPaymentRef: `${ref}-P${n}-${stamp}` },
    });
    expect(res.status(), await res.text()).toBe(201);
  };
  await pay('admin', partners.alpha, 'CUST-ALPHA', FIRST, 1);
  await pay('admin', partners.alpha, 'CUST-ALPHA', LAST, 2);
  await pay('otherAdmin', partners.foreign, 'CUST-FOREIGN', FIRST, 1);
  // A customer attributed without a payment yet (an account event does that).
  await prisma.affiliateCustomer.create({ data: { orgId: orgs.mine, partnerId: partners.beta, externalRef: 'CUST-BETA', partnerLabel: 'Acme Synthetic GmbH' } });
  for (const c of await prisma.affiliateCustomer.findMany({ where: { orgId: { in: [orgs.mine, orgs.other] } } })) customers[c.externalRef] = c.id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const orgId of Object.values(orgs).filter(Boolean)) {
    await prisma.affiliateCommission.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  }
  for (const e of Object.values(emails)) if (e) await cleanupByEmail(e);
  for (const orgId of Object.values(orgs).filter(Boolean)) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('one row per customer of the org: partner, payment span, count, window end and earned commission', { tag: '@smoke' }, async () => {
  const res = await list('admin');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ total: 2, page: 1, showWindow: true, currency: 'XTS' });
  const refs = body.rows.map((r: { ref: string }) => r.ref).sort();
  expect(refs).toEqual(['CUST-ALPHA', 'CUST-BETA']);

  const alpha = body.rows.find((r: { ref: string }) => r.ref === 'CUST-ALPHA');
  const earned = await prisma.affiliateCommission.aggregate({ where: { customerId: customers['CUST-ALPHA'], status: { not: 'REJECTED' } }, _sum: { amountMinor: true } });
  expect(earned._sum.amountMinor).toBeGreaterThan(0);
  expect(alpha).toMatchObject({
    partner: { id: partners.alpha, displayName: 'Alpha Partner' },
    payments: 2,
    firstPaymentAt: new Date(`${FIRST}T00:00:00Z`).toISOString(),
    lastPaymentAt: new Date(`${LAST}T00:00:00Z`).toISOString(),
    earnedMinor: earned._sum.amountMinor,
    window: { kind: 'ends', endsAt: customerWindowEndsAt(PLAN, new Date(`${FIRST}T00:00:00Z`))!.toISOString() },
  });

  const beta = body.rows.find((r: { ref: string }) => r.ref === 'CUST-BETA');
  expect(beta).toMatchObject({ label: 'Acme Synthetic GmbH', payments: 0, firstPaymentAt: null, lastPaymentAt: null, earnedMinor: 0, window: { kind: 'none' } });
});

test('read-only and org-scoped: an observer reads it, another org’s partner is 404', { tag: '@smoke' }, async () => {
  expect((await list('observer')).status()).toBe(200);
  const own = await (await list('admin', `?partnerId=${partners.alpha}`)).json();
  expect(own.rows.map((r: { ref: string }) => r.ref)).toEqual(['CUST-ALPHA']);
  expect((await list('admin', `?partnerId=${partners.foreign}`)).status()).toBe(404);
  expect((await list('admin', '?partnerId=does-not-exist')).status()).toBe(404);
  // The other org sees only its own customer.
  const other = await (await list('otherAdmin')).json();
  expect(other.rows.map((r: { ref: string }) => r.ref)).toEqual(['CUST-FOREIGN']);
  // No write method on the list.
  expect((await api.admin.post('/api/admin/affiliate/customers', { headers: host, data: {} })).status()).toBe(405);
});

test('the tabs come in two groups; the open group shows its screens', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.admin, PW, '/admin');

  await gotoSettled(page, '/admin/affiliates');
  await expect(page.getByTestId('affiliate-group-customers')).toBeVisible();
  await expect(page.getByTestId('affiliate-subtabs')).toHaveCount(0);

  await page.getByTestId('affiliate-group-customers').click();
  await expect(page).toHaveURL(/\/admin\/affiliates\/customers$/);
  await expect(page.getByTestId('affiliate-group-customers')).toHaveAttribute('aria-current', 'true');
  const sub = page.getByTestId('affiliate-subtabs');
  await expect(sub.getByRole('link', { name: 'Customer list' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('affiliate-customer-row')).toHaveCount(2);
  await expect(page.getByTestId('affiliate-customer-table').getByText('Alpha Partner')).toBeVisible();

  await sub.getByRole('link', { name: 'Customer payments' }).click();
  await expect(page).toHaveURL(/\/admin\/affiliates\/payments$/);
  await expect(page.getByTestId('affiliate-subtabs').getByRole('link', { name: 'Customer payments' })).toHaveAttribute('aria-current', 'page');

  await page.getByTestId('affiliate-group-partners').click();
  await expect(page).toHaveURL(/\/admin\/affiliates\/partners$/);
  await expect(page.getByTestId('affiliate-subtabs').getByRole('link', { name: 'Partner payouts' })).toBeVisible();
  await expect(page.getByTestId('affiliate-group-partners')).toHaveAttribute('aria-current', 'true');
});
