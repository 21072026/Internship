import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { recordAffiliatePayment, createPayout } from '../src/lib/affiliatePaymentWriter';
import { affiliateOverview } from '../src/lib/affiliateOverview';

/**
 * The affiliate overview tab (docs/affiliate-module.md, #3173).
 *
 * - Its totals are the Commissions tab's totals and its latest payout is the
 *   Payouts tab's first row: read through the three APIs and compared.
 * - `affiliate.read`: an OBSERVER reads it, a PROGRAM_ADMIN and a sales rep do not.
 * - A fixed number of queries whatever the programme's size (1 partner vs 25).
 * - An empty programme shows the setup steps; a running one the cards and shortcuts.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs per run.
 */

const PW = 'AffOverview123!';
const host = asHost(MARKETING_HOST);
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 10_000, commissionMinor: 1_000 }],
  topCommissionMinor: 2_000,
  percentBps: 1_000,
  switchAtCustomer: null,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};

const orgIds: string[] = [];
const emails: string[] = [];
const contexts: APIRequestContext[] = [];
let busy = '';
let empty = '';

async function newOrg(label: string, withPlan: boolean) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const id = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-ov-${label}-${stamp}`, vertical: 'MARKETING' } })).id;
  orgIds.push(id);
  if (withPlan) await prisma.affiliateProgramSettings.create({ data: { orgId: id, plan: PLAN, planVersion: 1, planEffectiveAt: new Date('2026-01-01T00:00:00Z'), contractVersion: 1 } });
  return id;
}
async function user(org: string, role: 'ADMIN' | 'MENTOR', level?: 'OBSERVER' | 'PROGRAM_ADMIN') {
  const email = uniqueEmail(`aff-ov-${level ?? role}`.toLowerCase());
  emails.push(email);
  const u = await seedUser(email, PW, role, 'Overview User', { orgId: org });
  if (level) await prisma.user.update({ where: { id: u.id }, data: { adminLevel: level } });
  return email;
}
async function signedIn(playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
  return ctx;
}
async function pay(orgId: string, partnerId: string, ref: string, day: string) {
  await recordAffiliatePayment({ orgId, partnerId, customerExternalRef: `C-${ref}`, amountMinor: 5_000, currency: 'EUR', receivedAt: new Date(`${day}T00:00:00Z`), externalPaymentRef: `INV-${ref}`, source: 'MANUAL' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  busy = await newOrg('busy', true);
  empty = await newOrg('empty', false);
  const p1 = (await prisma.affiliatePartner.create({ data: { orgId: busy, code: 'ov-1', displayName: 'Overview Partner One' } })).id;
  const p2 = (await prisma.affiliatePartner.create({ data: { orgId: busy, code: 'ov-2', displayName: 'Overview Partner Two' } })).id;
  await prisma.affiliatePartner.create({ data: { orgId: busy, code: 'ov-3', displayName: 'Overview Suspended', status: 'SUSPENDED' } });
  await prisma.affiliatePartner.create({ data: { orgId: busy, code: 'ov-4', displayName: 'Overview Ended', status: 'TERMINATED', noticeEffectiveAt: new Date('2026-02-01T00:00:00Z') } });
  for (const [i, day] of ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'].entries()) await pay(busy, i < 3 ? p1 : p2, `ov-${i}`, day);
  // p1: one PENDING, one APPROVED, one PAID; p2: one REJECTED.
  const rows = await prisma.affiliateCommission.findMany({ where: { orgId: busy }, orderBy: { accruedAt: 'asc' }, select: { id: true } });
  await prisma.affiliateCommission.updateMany({ where: { id: { in: [rows[1].id, rows[2].id] } }, data: { status: 'APPROVED' } });
  await prisma.affiliateCommission.update({ where: { id: rows[3].id }, data: { status: 'REJECTED' } });
  await createPayout(busy, { partnerId: p1, commissionIds: [rows[2].id], paidAt: new Date('2026-03-20T00:00:00Z') }, 'system');
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of orgIds) {
    await prisma.affiliateCommission.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePayout.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of emails) await cleanupByEmail(e);
  for (const id of orgIds) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('the overview totals are the Commissions and Payouts tabs\' totals; affiliate.read only', async ({ playwright, baseURL }) => {
  const observer = await signedIn(playwright, baseURL, await user(busy, 'ADMIN', 'OBSERVER'));
  const res = await observer.get('/api/admin/affiliate/overview', { headers: host });
  expect(res.status()).toBe(200);
  const ov = await res.json();
  const commissions = await (await observer.get('/api/admin/affiliate/commissions', { headers: host })).json();
  const payouts = await (await observer.get('/api/admin/affiliate/payouts', { headers: host })).json();

  expect(ov.commissions).toEqual(commissions.totals);
  expect(ov.commissions.PENDING).toEqual({ count: 1, amountMinor: 1_000 });
  expect(ov.latestPayout).toMatchObject({ id: payouts.rows[0].id, amountMinor: payouts.rows[0].amountMinor, paidAt: payouts.rows[0].paidAt });
  expect(ov.payouts).toEqual({ count: payouts.total, amountMinor: payouts.rows.reduce((n: number, r: { amountMinor: number }) => n + r.amountMinor, 0) });
  expect(ov.partners).toEqual({ ACTIVE: 2, SUSPENDED: 1, TERMINATED: 1 });
  expect(ov.customers).toBe(4);
  expect(ov.setup).toEqual({ plan: true, contract: true, partners: true });

  const prog = await signedIn(playwright, baseURL, await user(busy, 'ADMIN', 'PROGRAM_ADMIN'));
  expect((await prog.get('/api/admin/affiliate/overview', { headers: host })).status()).toBe(403);
  const rep = await signedIn(playwright, baseURL, await user(busy, 'MENTOR'));
  expect((await rep.get('/api/admin/affiliate/overview', { headers: host })).status()).toBe(403);
});

test('a fixed number of queries whatever the number of partners', async () => {
  const big = await newOrg('big', true);
  await prisma.affiliatePartner.createMany({ data: Array.from({ length: 25 }, (_, i) => ({ orgId: big, code: `ov-big-${i}`, displayName: `Big ${i}` })) });
  const partners = await prisma.affiliatePartner.findMany({ where: { orgId: big }, select: { id: true } });
  for (const [i, p] of partners.entries()) await pay(big, p.id, `big-${i}`, '2026-03-01');

  // Counts every model call the overview makes on the client it is handed.
  const counting = () => {
    let calls = 0;
    const client = new Proxy(appPrisma, {
      get(target, model) {
        const delegate = Reflect.get(target, model);
        if (!delegate || typeof delegate !== 'object') return delegate;
        return new Proxy(delegate, {
          get(d, method) {
            const fn = Reflect.get(d, method);
            return typeof fn === 'function' ? (...args: unknown[]) => (calls++, fn.apply(d, args)) : fn;
          },
        });
      },
    });
    return { client, calls: () => calls };
  };
  const small = counting();
  await affiliateOverview(busy, small.client);
  const large = counting();
  const ov = await affiliateOverview(big, large.client);
  expect(ov.partners.ACTIVE).toBe(25);
  expect(large.calls()).toBe(small.calls());
  expect(large.calls()).toBeLessThanOrEqual(6);
});

test('the screen: setup steps for an empty programme, cards and shortcuts for a running one', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(host);
  const emptyAdmin = await user(empty, 'ADMIN');
  await signInAndSettle(page, emptyAdmin, PW, '/admin');
  await gotoSettled(page, '/admin/affiliates');
  await expect(page.getByTestId('affiliate-overview-setup')).toBeVisible();
  for (const step of ['plan', 'contract', 'partner']) await expect(page.getByTestId(`affiliate-setup-${step}`)).toHaveAttribute('data-done', 'false');
  await expect(page.getByTestId('affiliate-overview-partners')).toHaveCount(0);

  await page.context().clearCookies();
  await signInAndSettle(page, await user(busy, 'ADMIN'), PW, '/admin');
  await gotoSettled(page, '/admin/affiliates');
  await expect(page.getByTestId('affiliate-overview-setup')).toHaveCount(0);
  await expect(page.getByTestId('affiliate-overview-partners-ACTIVE')).toHaveText('2');
  await expect(page.getByTestId('affiliate-overview-customers')).toHaveText('4');
  await expect(page.getByTestId('affiliate-overview-latest-payout')).toContainText('Overview Partner One');
  await page.getByTestId('affiliate-overview-to-approve').click();
  await expect(page).toHaveURL(/\/admin\/affiliates\/commissions\?status=PENDING$/, { timeout: 60_000 }); // a cold dev compile
  await expect(page.getByTestId('affiliate-commissions-PENDING')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
});
