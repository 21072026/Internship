import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { partnerFunnels, partnerThresholds } from '../src/lib/affiliateFunnel';
import { formatDate } from '../src/lib/relativeTime';

/**
 * The partner's funnel and threshold progress in the portal (#3543,
 * docs/affiliate-module.md "The funnel").
 *
 * One partner with a scenario across three periods: the funnel card shows the
 * numbers of each period, the threshold card shows "N / target" and how many
 * are left (then "applies since" once reached, and nothing when the plan has no
 * threshold), and the customer list carries a status badge and a status filter.
 * Another partner of the same org has customers and clicks too: none of them
 * reach this partner's numbers. The portal's numbers equal what the shared
 * aggregate returns for the admin side (every partner, no narrowing).
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run, invented references, currency XTS.
 */

const PW = 'AffFunnel123!';
const DAY = 24 * 60 * 60 * 1000;
const STAMP = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const PLAN = {
  currency: 'XTS',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 2_000,
  switchAtCustomer: 6,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};

let orgId = '';
let mineEmail = '';
let theirsEmail = '';
const ids = { mine: '', theirs: '' };
// Inside this UTC month whatever the hour the suite runs at.
const now = new Date();
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const thisMonth = new Date(Math.max(monthStart.getTime(), now.getTime() - 60_000));
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
let reachedAt: Date;

async function customer(partnerId: string, ref: string, createdAt: Date, payments: Date[], endedAt: Date | null = null) {
  const c = await prisma.affiliateCustomer.create({ data: { orgId, partnerId, externalRef: `${ref}-${STAMP}`, createdAt, endedAt } });
  for (const [i, receivedAt] of payments.entries()) {
    await prisma.affiliatePayment.create({
      data: { orgId, customerId: c.id, amountMinor: 500, currency: 'XTS', receivedAt, externalPaymentRef: `${ref}-${STAMP}-${i}` },
    });
  }
  return c;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales Funnel ${STAMP}`, slug: `aff-funnel-${STAMP}`, vertical: 'MARKETING' } })).id;
  mineEmail = uniqueEmail('aff-funnel-mine');
  theirsEmail = uniqueEmail('aff-funnel-theirs');
  const mineUser = await seedUser(mineEmail, PW, 'AFFILIATE', 'Mine Partner', { orgId });
  const theirsUser = await seedUser(theirsEmail, PW, 'AFFILIATE', 'Their Partner', { orgId });
  ids.mine = (await prisma.affiliatePartner.create({ data: { orgId, userId: mineUser.id, code: `mine-${STAMP}`, displayName: 'Mine' } })).id;
  ids.theirs = (await prisma.affiliatePartner.create({ data: { orgId, userId: theirsUser.id, code: `theirs-${STAMP}`, displayName: 'Theirs' } })).id;
  await prisma.affiliateProgramSettings.create({
    data: { orgId, contract: { en: 'Synthetic terms' }, contractVersion: 1, plan: PLAN, planVersion: 1, planEffectiveAt: ago(800), freeMonths: 2, passiveAfterDays: 45 },
  });
  await prisma.affiliateContractAcceptance.createMany({ data: [{ orgId, partnerId: ids.mine, version: 1 }, { orgId, partnerId: ids.theirs, version: 1 }] });

  // This month: one in the free period, one that left without paying, one paying.
  await customer(ids.mine, 'FREE', thisMonth, []);
  await customer(ids.mine, 'LEFT', thisMonth, [], thisMonth);
  await customer(ids.mine, 'NEWPAY', thisMonth, [thisMonth]);
  // Inside the last 12 months: passive, active again, never paid.
  await customer(ids.mine, 'OLDPASSIVE', ago(200), [ago(180)]);
  const e = await customer(ids.mine, 'OLDACTIVE', ago(160), [ago(150), ago(10)]);
  await customer(ids.mine, 'OLDLEFT', ago(170), []);
  // Older than 12 months, still paying.
  await customer(ids.mine, 'ANCIENT', ago(430), [ago(420), ago(5)]);
  // Paying customers by first payment: ANCIENT, OLDPASSIVE, OLDACTIVE, NEWPAY → 4.
  reachedAt = (await prisma.affiliatePayment.findFirstOrThrow({ where: { customerId: e.id }, orderBy: { receivedAt: 'asc' } })).receivedAt;

  await prisma.affiliateClickDaily.createMany({
    data: [
      { orgId, partnerId: ids.mine, day: utcDay(thisMonth), clicks: 8, uniqueClicks: 6 },
      { orgId, partnerId: ids.mine, day: utcDay(ago(90)), clicks: 20, uniqueClicks: 15 },
      { orgId, partnerId: ids.mine, day: utcDay(ago(600)), clicks: 30, uniqueClicks: 25 },
      // Another partner's: never in this partner's numbers.
      { orgId, partnerId: ids.theirs, day: utcDay(thisMonth), clicks: 99, uniqueClicks: 90 },
    ],
  });
  await customer(ids.theirs, 'THEIRS1', thisMonth, [thisMonth]);
  await customer(ids.theirs, 'THEIRS2', thisMonth, []);
});

test.afterAll(async () => {
  if (orgId) {
    const where = { orgId };
    await prisma.affiliateClickDaily.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCommission.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where }).catch(() => {});
    await prisma.affiliateContractAcceptance.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where }).catch(() => {});
  }
  for (const e of [mineEmail, theirsEmail]) if (e) await cleanupByEmail(e);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

const EXPECTED = {
  month: { clicks: '8', registrations: '3', paying: '1', active: '1', regRate: '38', payRate: '33', activeRate: '100', split: [1, 1], passive: 0 },
  year: { clicks: '28', registrations: '6', paying: '3', active: '2', regRate: '21', payRate: '50', activeRate: '67', split: [1, 2], passive: 1 },
  all: { clicks: '58', registrations: '7', paying: '4', active: '3', regRate: '12', payRate: '57', activeRate: '75', split: [1, 2], passive: 1 },
} as const;

test('the funnel shows the partner’s own numbers per period, equal to the shared aggregate', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mineEmail, PW, '/affiliate');

  for (const period of ['month', 'year', 'all'] as const) {
    if (period !== 'month') await gotoSettled(page, `/affiliate?period=${period}`);
    const x = EXPECTED[period];
    await expect(page.getByTestId(`affiliate-funnel-period-${period}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('affiliate-funnel-clicks-value')).toHaveText(x.clicks);
    await expect(page.getByTestId('affiliate-funnel-registrations-value')).toHaveText(x.registrations);
    await expect(page.getByTestId('affiliate-funnel-paying-value')).toHaveText(x.paying);
    await expect(page.getByTestId('affiliate-funnel-active-value')).toHaveText(x.active);
    await expect(page.getByTestId('affiliate-funnel-registrations-rate')).toContainText(x.regRate);
    await expect(page.getByTestId('affiliate-funnel-paying-rate')).toContainText(x.payRate);
    await expect(page.getByTestId('affiliate-funnel-active-rate')).toContainText(x.activeRate);
    await expect(page.getByTestId('affiliate-funnel-registrations-sub')).toHaveText(`${x.split[0]} in free period · ${x.split[1]} left without paying`);
    await expect(page.getByTestId('affiliate-funnel-active-sub')).toHaveText(`${x.passive} passive`);

    // The admin side reads every partner through the same aggregate: same numbers.
    const admin = (await partnerFunnels(orgId, { period })).get(ids.mine)!;
    expect([admin.clicks, admin.registrations, admin.paying, admin.active].map(String)).toEqual([x.clicks, x.registrations, x.paying, x.active]);
    expect(admin.passive).toBe(x.passive);
  }
});

test('the threshold shows how many are left, then since when it applies, and hides without a threshold', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mineEmail, PW, '/affiliate');
  await expect(page.getByTestId('affiliate-threshold-count')).toHaveText('4 / 6 paying customers');
  await expect(page.getByTestId('affiliate-threshold-status')).toHaveText('2 more paying customers until every payment earns 20 %.');
  expect((await partnerThresholds(orgId)).get(ids.mine)).toMatchObject({ target: 6, paying: 4, left: 2 });

  // The third paying customer by first-payment date switches it on.
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: { ...PLAN, switchAtCustomer: 3 } } });
  await gotoSettled(page, '/affiliate');
  await expect(page.getByTestId('affiliate-threshold-count')).toHaveText('4 / 3 paying customers');
  await expect(page.getByTestId('affiliate-threshold-status')).toHaveText(
    `20 % applies since ${formatDate(reachedAt.toISOString(), 'en', { timeZone: 'UTC' })}.`,
  );

  // No threshold in the plan: no indicator at all.
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: { ...PLAN, switchAtCustomer: null, percentBps: 0 } } });
  await gotoSettled(page, '/affiliate');
  await expect(page.getByTestId('affiliate-funnel')).toBeVisible();
  await expect(page.getByTestId('affiliate-threshold')).toHaveCount(0);
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { plan: PLAN } });
});

test('the customer list carries a status badge and filters by status, own customers only', async ({ page }) => {
  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, mineEmail, PW, '/affiliate');
  await gotoSettled(page, '/affiliate/customers');
  const table = page.getByTestId('affiliate-customers-table');
  await expect(table.locator('tbody tr')).toHaveCount(7);
  await expect(table).not.toContainText('THEIRS');
  await expect(page.getByTestId(`affiliate-customer-FREE-${STAMP}`).getByTestId('affiliate-customer-status')).toHaveAttribute('data-status', 'FREE_PERIOD');
  await expect(page.getByTestId(`affiliate-customer-LEFT-${STAMP}`).getByTestId('affiliate-customer-status')).toHaveText('Left without paying');
  await expect(page.getByTestId(`affiliate-customer-OLDPASSIVE-${STAMP}`).getByTestId('affiliate-customer-status')).toHaveText('Passive');
  await expect(page.getByTestId('affiliate-customers-filter-ACTIVE')).toHaveText('Active (3)');

  await page.getByTestId('affiliate-customers-filter-ACTIVE').click();
  await expect(page).toHaveURL(/status=ACTIVE/);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  for (const ref of ['NEWPAY', 'OLDACTIVE', 'ANCIENT']) await expect(page.getByTestId(`affiliate-customer-${ref}-${STAMP}`)).toBeVisible();

  // An unknown status is no filter at all.
  await gotoSettled(page, '/affiliate/customers?status=BOGUS');
  await expect(table.locator('tbody tr')).toHaveCount(7);
});
