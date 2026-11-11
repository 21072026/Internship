import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * The partner funnel in the admin panel (docs/affiliate-module.md § Partner
 * funnel, #3544). Two synthetic partners whose numbers differ in every column:
 *
 * - ALPHA: many clicks today, no registration in the last 12 months, and four
 *   old customers who all still pay — the plan switched at its 4th customer,
 *   and their 24-month commission windows end in ten days.
 * - BETA: a few clicks; four customers registered in the last weeks — one
 *   active, two passive (cancelled after paying), one in the free period.
 *
 * Checked through the API (numbers, the allowlisted sort, a 400 for an unknown
 * key, `affiliate.read` only, another org's partner never counted) and the
 * screen (cells, badges, header sort, period switch, the overview's org total).
 * The `year` period is used throughout: `month` starts on the 1st, so dates a
 * few weeks back would fall in or out of it depending on the day of the run.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs per run.
 */

const PW = 'AffFunnel123!';
const host = asHost(MARKETING_HOST);
const DAY = 24 * 60 * 60 * 1000;
const STAMP = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 10_000, commissionMinor: 1_000 }],
  topCommissionMinor: 2_000,
  percentBps: 2_000,
  switchAtCustomer: 4,
  boundaryCustomer: 'PERCENT',
  windowMonths: 24,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};
const ALPHA = `fa-${STAMP}`;
const BETA = `fb-${STAMP}`;

const orgIds: string[] = [];
const emails: string[] = [];
const contexts: APIRequestContext[] = [];
let orgId = '';
let otherOrgId = '';

const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function newOrg(label: string) {
  const id = (await prisma.organization.create({ data: { name: `Acme Sales Funnel ${label} ${STAMP}`, slug: `aff-fn-${label}-${STAMP}`, vertical: 'MARKETING' } })).id;
  orgIds.push(id);
  await prisma.affiliateProgramSettings.create({ data: { orgId: id, plan: PLAN, planVersion: 1, planEffectiveAt: new Date('2026-01-01T00:00:00Z'), contractVersion: 1 } });
  return id;
}
async function user(org: string, role: 'ADMIN' | 'MENTOR', level?: 'OBSERVER' | 'PROGRAM_ADMIN') {
  const email = uniqueEmail(`aff-fn-${level ?? role}`.toLowerCase());
  emails.push(email);
  const u = await seedUser(email, PW, role, 'Funnel User', { orgId: org });
  if (level) await prisma.user.update({ where: { id: u.id }, data: { adminLevel: level } });
  return email;
}
async function signedIn(playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
  return ctx;
}
let refSeq = 0;
async function customer(org: string, partnerId: string, createdAt: Date, payments: Date[], endedAt: Date | null = null) {
  const c = await prisma.affiliateCustomer.create({ data: { orgId: org, partnerId, externalRef: `acct-${STAMP}-${++refSeq}`, createdAt, endedAt } });
  for (const receivedAt of payments) {
    await prisma.affiliatePayment.create({
      data: { orgId: org, customerId: c.id, amountMinor: 5_000, currency: 'EUR', receivedAt, externalPaymentRef: `INV-${STAMP}-${++refSeq}` },
    });
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = await newOrg('a');
  otherOrgId = await newOrg('b');
  const alpha = (await prisma.affiliatePartner.create({ data: { orgId, code: ALPHA, displayName: 'Alpha Funnel' } })).id;
  const beta = (await prisma.affiliatePartner.create({ data: { orgId, code: BETA, displayName: 'Beta Funnel' } })).id;
  const other = (await prisma.affiliatePartner.create({ data: { orgId: otherOrgId, code: `fo-${STAMP}`, displayName: 'Other Org Funnel' } })).id;

  // Clicks: Alpha 150/120 today + 10/10 four hundred days ago; Beta 20/10 today; another org's 999.
  await prisma.affiliateClickDaily.createMany({
    data: [
      { orgId, partnerId: alpha, day: utcDay(now), clicks: 150, uniqueClicks: 120 },
      { orgId, partnerId: alpha, day: utcDay(ago(400)), clicks: 10, uniqueClicks: 10 },
      { orgId, partnerId: beta, day: utcDay(now), clicks: 20, uniqueClicks: 10 },
      { orgId: otherOrgId, partnerId: other, day: utcDay(now), clicks: 999, uniqueClicks: 999 },
    ],
  });

  // Alpha: four customers from long ago, first paid 24 months minus ten days ago, still paying.
  const firstPaid = new Date(now);
  firstPaid.setUTCFullYear(firstPaid.getUTCFullYear() - 2);
  for (let i = 0; i < 4; i++) await customer(orgId, alpha, ago(800), [new Date(firstPaid.getTime() + (10 * DAY) + i * 60_000), ago(2)]);

  // Beta: four registrations in the last weeks.
  await customer(orgId, beta, ago(10), [ago(5)]); // ACTIVE
  await customer(orgId, beta, ago(20), [ago(15)], ago(3)); // PASSIVE (cancelled after paying)
  await customer(orgId, beta, ago(25), [ago(20)], ago(2)); // PASSIVE
  await customer(orgId, beta, ago(3), []); // FREE_PERIOD

  // Another org's customer, registered today and paying: never in this org's funnel.
  await customer(otherOrgId, other, ago(1), [ago(1)]);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of orgIds) {
    await prisma.affiliatePayment.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateClickDaily.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of emails) await cleanupByEmail(e);
  for (const id of orgIds) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
});

type Row = Record<string, unknown> & { code: string };

test('the numbers per partner and in total, the allowlisted sort, affiliate.read only', async ({ playwright, baseURL }) => {
  const observer = await signedIn(playwright, baseURL, await user(orgId, 'ADMIN', 'OBSERVER'));
  const get = (qs: string) => observer.get(`/api/admin/affiliate/funnel?${qs}`, { headers: host });

  const res = await get('period=year&sort=clicks&dir=desc');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.rows.map((r: Row) => r.code)).toEqual([ALPHA, BETA]); // another org's partner is not listed
  expect(body.switchAtCustomer).toBe(4);
  const [alpha, beta] = body.rows as Row[];
  expect(alpha).toMatchObject({
    clicks: 150, uniqueClicks: 120, registrations: 0, paying: 0, active: 0, passive: 0,
    registrationRate: 0, payingRate: null, toThreshold: 0, windowEndingSoon: 4,
    badges: ['CLICKS_NO_SIGNUPS', 'WINDOW_ENDING'],
  });
  expect(beta).toMatchObject({
    clicks: 20, uniqueClicks: 10, registrations: 4, paying: 3, active: 1, passive: 2, freePeriod: 1, neverPaid: 0,
    registrationRate: 20, payingRate: 75, toThreshold: 1, windowEndingSoon: 0,
    badges: ['MOSTLY_PASSIVE'],
  });
  expect(body.total).toMatchObject({ clicks: 170, uniqueClicks: 130, registrations: 4, paying: 3, active: 1, passive: 2 });

  // "All time": Alpha's older clicks and old customers count too; the threshold does not move.
  const all = await (await get('period=all')).json();
  const allAlpha = all.rows.find((r: Row) => r.code === ALPHA);
  expect(allAlpha).toMatchObject({ clicks: 160, registrations: 4, paying: 4, active: 4, toThreshold: 0 });
  expect(allAlpha.badges).toEqual(['WINDOW_ENDING']);
  expect(all.total).toMatchObject({ clicks: 180, registrations: 8, paying: 7 });

  // Sorting by an allowlisted key, both ways; a rate with no value sorts last.
  const order = async (qs: string) => ((await (await get(`period=year&${qs}`)).json()).rows as Row[]).map((r) => r.code);
  expect(await order('sort=registrations&dir=desc')).toEqual([BETA, ALPHA]);
  expect(await order('sort=registrations&dir=asc')).toEqual([ALPHA, BETA]);
  expect(await order('sort=partner&dir=desc')).toEqual([BETA, ALPHA]);
  expect(await order('sort=payingRate&dir=asc')).toEqual([BETA, ALPHA]);
  expect(await order('sort=toThreshold&dir=asc')).toEqual([ALPHA, BETA]);

  // Anything outside the allowlist is refused, never handed to a query.
  for (const qs of ['sort=displayName', 'sort=orgId', 'dir=sideways', 'period=30d', 'page=0']) expect((await get(qs)).status()).toBe(400);

  // The overview's org total is the funnel's "all time" total.
  const ov = await (await observer.get('/api/admin/affiliate/overview', { headers: host })).json();
  expect(all.total).toMatchObject(ov.funnel);
  expect(ov.funnel.clicks).toBe(180);

  const prog = await signedIn(playwright, baseURL, await user(orgId, 'ADMIN', 'PROGRAM_ADMIN'));
  expect((await prog.get('/api/admin/affiliate/funnel', { headers: host })).status()).toBe(403);
  const rep = await signedIn(playwright, baseURL, await user(orgId, 'MENTOR'));
  expect((await rep.get('/api/admin/affiliate/funnel', { headers: host })).status()).toBe(403);
});

test('the screen: cells, badges, header sort, period, and the overview total', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(host);
  await signInAndSettle(page, await user(orgId, 'ADMIN'), PW, '/admin');
  await gotoSettled(page, '/admin/affiliates/funnel?period=year');

  const rows = page.getByTestId('affiliate-funnel-table').locator('tbody tr');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.first()).toHaveAttribute('data-testid', `affiliate-funnel-row-${ALPHA}`);
  await expect(page.getByTestId(`affiliate-funnel-${BETA}-registrations`)).toHaveText('4');
  await expect(page.getByTestId(`affiliate-funnel-${BETA}-passive`)).toHaveText('2');
  await expect(page.getByTestId(`affiliate-funnel-${BETA}-toThreshold`)).toHaveText('1');
  await expect(page.getByTestId(`affiliate-funnel-${ALPHA}-toThreshold`)).toHaveText('Reached');
  await expect(page.getByTestId(`affiliate-funnel-row-${ALPHA}`).getByTestId('affiliate-funnel-badge-CLICKS_NO_SIGNUPS')).toBeVisible();
  await expect(page.getByTestId(`affiliate-funnel-row-${ALPHA}`).getByTestId('affiliate-funnel-badge-WINDOW_ENDING')).toBeVisible();
  await expect(page.getByTestId(`affiliate-funnel-row-${BETA}`).getByTestId('affiliate-funnel-badge-MOSTLY_PASSIVE')).toBeVisible();
  await expect(page.getByTestId('affiliate-funnel-total-clicks')).toHaveText('170');

  // A header click sorts on the server and writes the view into the URL.
  await page.getByTestId('affiliate-funnel-sort-registrations').click();
  await expect(page).toHaveURL(/sort=registrations&dir=desc/);
  await expect(rows.first()).toHaveAttribute('data-testid', `affiliate-funnel-row-${BETA}`);
  await page.getByTestId('affiliate-funnel-sort-registrations').click();
  await expect(page).toHaveURL(/sort=registrations&dir=asc/);
  await expect(rows.first()).toHaveAttribute('data-testid', `affiliate-funnel-row-${ALPHA}`);

  await page.getByTestId('affiliate-funnel-period-all').click();
  await expect(page.getByTestId(`affiliate-funnel-${ALPHA}-registrations`)).toHaveText('4');
  await expect(page.getByTestId('affiliate-funnel-total-clicks')).toHaveText('180');

  await gotoSettled(page, '/admin/affiliates');
  await expect(page.getByTestId('affiliate-overview-funnel-clicks')).toHaveText('180', { timeout: 30_000 });
  await expect(page.getByTestId('affiliate-overview-funnel-paying')).toHaveText('7');
});
