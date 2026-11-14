import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * Filters and sort of the admin's affiliate lists (#3539, docs/affiliate-module.md
 * "Admin screens"): commissions, customer payments, partner payouts, partners.
 *
 * Filtering and sorting happen on the SERVER (the lists are paged), from an
 * allowlist: an unknown sort, status or day is a 400, never passed to a query.
 * Every query is the session's org: another org's partner id matches nothing.
 * The commission totals per status follow the filters, and the screen keeps its
 * view in the URL.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs, example labels, XTS amounts.
 */

const PW = 'AffFilters123!';
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

const orgs = { mine: '', other: '' };
const emails = { admin: '', otherAdmin: '' };
const partners = { alpha: '', beta: '', foreign: '' };
const contexts: APIRequestContext[] = [];
const api: Record<string, APIRequestContext> = {};
let stamp = '';

test.describe.configure({ mode: 'serial' });

const get = async (who: string, path: string) => {
  const res = await api[who].get(path, { headers: host });
  return { status: res.status(), body: res.status() === 200 ? await res.json() : null };
};

test.beforeAll(async ({ playwright, baseURL }) => {
  stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  for (const k of ['mine', 'other'] as const) {
    orgs[k] = (await prisma.organization.create({ data: { name: `Acme Sales ${k} ${stamp}`, slug: `aff-filter-${k}-${stamp}`, vertical: 'MARKETING' } })).id;
    await prisma.affiliateProgramSettings.create({ data: { orgId: orgs[k], plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  }
  emails.admin = uniqueEmail('aff-filter-admin');
  emails.otherAdmin = uniqueEmail('aff-filter-other');
  await seedUser(emails.admin, PW, 'ADMIN', 'Filters Admin', { orgId: orgs.mine });
  await seedUser(emails.otherAdmin, PW, 'ADMIN', 'Other Admin', { orgId: orgs.other });

  partners.alpha = (await prisma.affiliatePartner.create({ data: { orgId: orgs.mine, code: `flt-alpha-${stamp}`, displayName: 'Alpha Partner', contactEmail: 'alpha@partner.example' } })).id;
  partners.beta = (await prisma.affiliatePartner.create({ data: { orgId: orgs.mine, code: `flt-beta-${stamp}`, displayName: 'Beta Partner', status: 'SUSPENDED' } })).id;
  partners.foreign = (await prisma.affiliatePartner.create({ data: { orgId: orgs.other, code: `flt-foreign-${stamp}`, displayName: 'Foreign Partner' } })).id;

  for (const [who, email] of Object.entries(emails)) {
    const ctx = await playwright.request.newContext({ baseURL });
    contexts.push(ctx);
    expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok, who).toBe(true);
    api[who] = ctx;
  }

  // Through the one writer, so the commissions are the engine's. Beta is paid
  // while still active, then suspended (a suspended partner takes no new payment).
  await prisma.affiliatePartner.update({ where: { id: partners.beta }, data: { status: 'ACTIVE' } });
  const pay = async (who: string, partnerId: string, ref: string, amountMinor: number, receivedOn: string, n: number) => {
    const res = await api[who].post('/api/admin/affiliate/payments', {
      headers: host,
      data: { partnerId, customerExternalRef: ref, amountMinor, receivedOn, externalPaymentRef: `${ref}-P${n}-${stamp}` },
    });
    expect(res.status(), await res.text()).toBe(201);
  };
  await pay('admin', partners.alpha, 'CUST-A1', 4_000, '2026-03-02', 1);
  await pay('admin', partners.alpha, 'CUST-A1', 9_000, '2026-04-15', 2);
  await pay('admin', partners.alpha, 'CUST-A2', 6_000, '2026-05-20', 1);
  await pay('admin', partners.beta, 'CUST-B1', 7_000, '2026-04-01', 1);
  await pay('otherAdmin', partners.foreign, 'CUST-F1', 5_000, '2026-04-01', 1);
  await prisma.affiliatePartner.update({ where: { id: partners.beta }, data: { status: 'SUSPENDED' } });
  await prisma.affiliateCustomer.updateMany({ where: { orgId: orgs.mine, externalRef: 'CUST-A2' }, data: { partnerLabel: 'Acme Synthetic GmbH' } });

  // One payout for alpha: approve its oldest commission and pay it.
  const oldest = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId: orgs.mine, partnerId: partners.alpha }, orderBy: { dueAt: 'asc' } });
  const approve = await api.admin.post('/api/admin/affiliate/commissions/transition', { headers: host, data: { ids: [oldest.id], transition: 'APPROVE' } });
  expect(approve.status(), await approve.text()).toBe(200);
  const payout = await api.admin.post('/api/admin/affiliate/payouts', { headers: host, data: { partnerId: partners.alpha, commissionIds: [oldest.id], paidOn: '2026-04-20', reference: `BANK-${stamp}` } });
  expect(payout.status(), await payout.text()).toBe(201);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const orgId of Object.values(orgs).filter(Boolean)) {
    await prisma.affiliateCommission.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePayout.deleteMany({ where: { orgId } }).catch(() => {});
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

test('commissions: partner filter, sort by amount, totals follow the filter; refused values are a 400', { tag: '@smoke' }, async () => {
  const all = await get('admin', '/api/admin/affiliate/commissions');
  expect(all.status).toBe(200);
  expect(all.body.total).toBe(4);

  const alpha = await get('admin', `/api/admin/affiliate/commissions?partnerId=${partners.alpha}&sort=amount&dir=desc`);
  expect(alpha.body.total).toBe(3);
  const amounts = alpha.body.rows.map((r: { amountMinor: number }) => r.amountMinor);
  expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
  expect(new Set(alpha.body.rows.map((r: { partner: { id: string } }) => r.partner.id))).toEqual(new Set([partners.alpha]));
  // The totals per status are those of the filtered list, not the programme's.
  const counted = Object.values(alpha.body.totals as Record<string, { count: number }>).reduce((n, t) => n + t.count, 0);
  expect(counted).toBe(3);
  expect(alpha.body.totals.PAID.count).toBe(1);

  const paid = await get('admin', `/api/admin/affiliate/commissions?partnerId=${partners.alpha}&status=PAID`);
  expect(paid.body.total).toBe(1);

  // Another org's partner: an empty list, never its rows.
  const foreign = await get('admin', `/api/admin/affiliate/commissions?partnerId=${partners.foreign}`);
  expect(foreign.status).toBe(200);
  expect(foreign.body.total).toBe(0);

  for (const bad of ['sort=createdAt', 'sort=__proto__', 'dir=sideways', 'status=OPEN', 'kind=BONUS', 'from=2026-02-31', 'from=2026-05-02&to=2026-05-01']) {
    expect((await get('admin', `/api/admin/affiliate/commissions?${bad}`)).status, bad).toBe(400);
  }
});

test('payments and payouts: search, received / paid days, sort; another org sees only its own', { tag: '@smoke' }, async () => {
  const byRef = await get('admin', '/api/admin/affiliate/payments?q=CUST-A1');
  expect(byRef.body.rows.map((r: { customerRef: string }) => r.customerRef)).toEqual(['CUST-A1', 'CUST-A1']);
  const byLabel = await get('admin', '/api/admin/affiliate/payments?q=Synthetic');
  expect(byLabel.body.rows.map((r: { customerRef: string }) => r.customerRef)).toEqual(['CUST-A2']);

  // Both ends inclusive: 1 April to 15 April holds two payments.
  const april = await get('admin', '/api/admin/affiliate/payments?from=2026-04-01&to=2026-04-15&sort=amount&dir=asc');
  expect(april.body.rows.map((r: { amountMinor: number }) => r.amountMinor)).toEqual([7_000, 9_000]);
  expect((await get('admin', '/api/admin/affiliate/payments?sort=receivedAt')).status).toBe(400);
  expect((await get('admin', `/api/admin/affiliate/payments?q=${'x'.repeat(101)}`)).status).toBe(400);
  expect((await get('otherAdmin', '/api/admin/affiliate/payments?q=CUST')).body.rows.map((r: { customerRef: string }) => r.customerRef)).toEqual(['CUST-F1']);

  const payouts = await get('admin', `/api/admin/affiliate/payouts?q=BANK-${stamp}&from=2026-04-20&to=2026-04-20`);
  expect(payouts.body.total).toBe(1);
  expect((await get('admin', '/api/admin/affiliate/payouts?from=2026-04-21')).body.total).toBe(0);
  expect((await get('admin', `/api/admin/affiliate/payouts?partnerId=${partners.beta}`)).body.total).toBe(0);
});

test('partners: status and search filters, sort by open commission', async () => {
  const suspended = await get('admin', '/api/admin/affiliate/partners?status=SUSPENDED');
  expect(suspended.body.partners.map((p: { id: string }) => p.id)).toEqual([partners.beta]);
  const byEmail = await get('admin', '/api/admin/affiliate/partners?q=alpha%40partner');
  expect(byEmail.body.partners.map((p: { id: string }) => p.id)).toEqual([partners.alpha]);
  const open = await get('admin', '/api/admin/affiliate/partners?sort=open&dir=desc');
  const sums = open.body.partners.map((p: { totals: { PENDING: number; APPROVED: number } }) => p.totals.PENDING + p.totals.APPROVED);
  expect(sums).toEqual([...sums].sort((a, b) => b - a));
  expect((await get('admin', '/api/admin/affiliate/partners?sort=iban')).status).toBe(400);
});

test('the commission screen keeps its filters in the URL; a changed filter clears the selection', async ({ page }) => {
  test.slow();
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, emails.admin, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/commissions');

  const rows = page.getByTestId('affiliate-commission-row');
  await expect(rows).toHaveCount(3); // pending: alpha's two not yet paid + beta's
  await page.getByTestId('affiliate-commission-table').locator('thead input[type="checkbox"]').check();
  await expect(page.getByTestId('affiliate-commission-APPROVE')).toBeEnabled();

  await page.getByTestId('affiliate-filter-partner').selectOption(partners.alpha);
  await expect(page).toHaveURL(new RegExp(`partnerId=${partners.alpha}`));
  await expect(rows).toHaveCount(2);
  // The bulk action has nothing selected after the list changed.
  await expect(page.getByTestId('affiliate-commission-APPROVE')).toBeDisabled();

  await page.getByTestId('affiliate-commissions-PAID').click();
  await expect(page).toHaveURL(/status=PAID/);
  await expect(rows).toHaveCount(1);

  await page.getByTestId('affiliate-sort-amount').click();
  await expect(page).toHaveURL(/sort=amount/);
  await expect(page.getByTestId('affiliate-sort-amount').locator('xpath=..')).toHaveAttribute('aria-sort', 'descending');

  // A link opens the same view.
  await gotoSettled(page, page.url());
  await expect(page.getByTestId('affiliate-filter-partner')).toHaveValue(partners.alpha);
  await expect(rows).toHaveCount(1);

  await page.getByTestId('affiliate-filter-clear').click();
  await expect(page).not.toHaveURL(/partnerId=/);
  await expect(rows).toHaveCount(3);
});
