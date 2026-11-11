import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';

/**
 * The partner's window notice (#3556, docs/affiliate-module.md "Window notice").
 *
 * The lead time is an admin setting, validated and audited. The daily job,
 * run by hand through `/api/cron?job=affiliate-window-notices`, tells a partner
 * once about the customers whose percent window ends within the lead time —
 * never about one that ends later or has already ended, never a partner with no
 * account or a suspended one — and a second run sends nothing. A tenant admin
 * cannot move the job's clock.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org, example labels, XTS amounts.
 * Dates are built from the real "now", so the run needs no clock override.
 */

const PW = 'AffWindow123!';
const host = asHost(MARKETING_HOST);
const DAY = 24 * 60 * 60 * 1000;
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

let orgId = '';
let adminEmail = '';
let partnerEmail = '';
let suspendedEmail = '';
let partnerUserId = '';
const partners = { mine: '', noAccount: '', suspended: '' };
const customers: Record<string, string> = {};
const contexts: APIRequestContext[] = [];
let admin: APIRequestContext;

test.describe.configure({ mode: 'serial' });

/** The first payment whose 6-month window ends `daysAhead` days from now (± a month-end clamp). */
function firstPaymentFor(daysAhead: number): Date {
  const d = new Date(Date.now() + daysAhead * DAY);
  d.setUTCMonth(d.getUTCMonth() - 6);
  return d;
}

async function seedCustomer(partnerId: string, ref: string, daysAhead: number, partnerLabel: string | null = null) {
  const c = await prisma.affiliateCustomer.create({ data: { orgId, partnerId, externalRef: ref, partnerLabel } });
  await prisma.affiliatePayment.create({
    data: { orgId, customerId: c.id, amountMinor: 500, currency: 'XTS', receivedAt: firstPaymentFor(daysAhead), externalPaymentRef: `${ref}-P1` },
  });
  customers[ref] = c.id;
}

const run = (query = '') => admin.get(`/api/cron?job=affiliate-window-notices${query}`, { headers: host });
const sentAt = async (ref: string) =>
  (await prisma.affiliateCustomer.findUnique({ where: { id: customers[ref] }, select: { windowNoticeSentAt: true } }))?.windowNoticeSentAt ?? null;
// The ledger stores a hash of the caller's dedupe key, so the row is found by event and recipient.
const deliveries = () => prisma.notificationDelivery.findMany({ where: { eventKey: 'affiliate.windowEnding', userId: partnerUserId } });

test.beforeAll(async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-window-${stamp}`, vertical: 'MARKETING' } })).id;
  adminEmail = uniqueEmail('aff-window-admin');
  partnerEmail = uniqueEmail('aff-window-partner');
  suspendedEmail = uniqueEmail('aff-window-suspended');
  await seedUser(adminEmail, PW, 'ADMIN', 'Window Admin', { orgId });
  partnerUserId = (await seedUser(partnerEmail, PW, 'AFFILIATE', 'Window Partner', { orgId })).id;
  const suspendedUser = await seedUser(suspendedEmail, PW, 'AFFILIATE', 'Suspended Partner', { orgId });
  partners.mine = (await prisma.affiliatePartner.create({ data: { orgId, userId: partnerUserId, code: 'win-mine', displayName: 'Mine' } })).id;
  partners.noAccount = (await prisma.affiliatePartner.create({ data: { orgId, code: 'win-none', displayName: 'No account' } })).id;
  partners.suspended = (
    await prisma.affiliatePartner.create({ data: { orgId, userId: suspendedUser.id, code: 'win-susp', displayName: 'Suspended', status: 'SUSPENDED' } })
  ).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });

  await seedCustomer(partners.mine, 'WIN-DUE', 10, 'Acme Synthetic GmbH');
  await seedCustomer(partners.mine, 'WIN-LATER', 60);
  await seedCustomer(partners.mine, 'WIN-ENDED', -2);
  await seedCustomer(partners.noAccount, 'WIN-NOACC', 10);
  await seedCustomer(partners.suspended, 'WIN-SUSP', 10);

  admin = await playwright.request.newContext({ baseURL });
  contexts.push(admin);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (orgId) {
    const keys = (await deliveries().catch(() => [])).map((d) => `notify:${d.dedupeKey}`);
    if (keys.length) await prisma.job.deleteMany({ where: { idempotencyKey: { in: keys } } }).catch(() => {});
    await prisma.notificationDelivery.deleteMany({ where: { userId: partnerUserId } }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  }
  for (const e of [adminEmail, partnerEmail, suspendedEmail]) if (e) await cleanupByEmail(e);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('the lead time is validated, stored and audited', async () => {
  const put = (data: unknown) => admin.put('/api/admin/affiliate/settings/window-notice', { headers: host, data });
  for (const bad of [{ windowNoticeDays: 181 }, { windowNoticeDays: -1 }, { windowNoticeDays: 1.5 }, { windowNoticeDays: 'x' }, {}]) {
    const res = await put(bad);
    expect(res.status(), JSON.stringify(bad)).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_input' });
  }
  expect(await (await put({ windowNoticeDays: 14 })).json()).toMatchObject({ ok: true, windowNoticeDays: 14, changed: true });
  expect(await (await put({ windowNoticeDays: 14 })).json()).toMatchObject({ windowNoticeDays: 14, changed: false });
  const settings = await (await admin.get('/api/admin/affiliate/settings', { headers: host })).json();
  expect(settings.windowNoticeDays).toBe(14);
  const audits = await prisma.auditLog.findMany({ where: { orgId, action: 'affiliate.window_notice.update' } });
  expect(audits).toHaveLength(1);
  expect(JSON.parse(audits[0].detail ?? '{}')).toEqual({ from: 30, to: 14 });
  expect((await put({ windowNoticeDays: 30 })).status()).toBe(200);
});

test('turned off, the job tells nobody', async () => {
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { windowNoticeDays: 0 } });
  const res = await run();
  expect(res.status()).toBe(200);
  expect((await res.json()).windowNotices).toMatchObject({ programmes: 0, claimed: 0, mailed: 0 });
  expect(await sentAt('WIN-DUE')).toBeNull();
  await prisma.affiliateProgramSettings.update({ where: { orgId }, data: { windowNoticeDays: 30 } });
});

test('a tenant admin cannot move the clock: ?at= is ignored', async () => {
  // Honoured, a date two months ahead would make WIN-LATER due (and spend its notice early).
  const res = await run(`&at=${encodeURIComponent(new Date(Date.now() + 55 * DAY).toISOString())}`);
  expect(res.status()).toBe(200);
  expect(await sentAt('WIN-LATER')).toBeNull();
  // The run was "now", so it did the real work: only WIN-DUE.
  expect((await res.json()).windowNotices).toMatchObject({ claimed: 1, mailed: 1 });
});

test('one claim and one mail for the due customer only; a second run sends nothing', async () => {
  expect(await sentAt('WIN-DUE')).not.toBeNull();
  for (const ref of ['WIN-LATER', 'WIN-ENDED', 'WIN-NOACC', 'WIN-SUSP']) expect(await sentAt(ref), ref).toBeNull();
  const first = await deliveries();
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ userId: partnerUserId, channel: 'email', orgId });

  const again = await run();
  expect(again.status()).toBe(200);
  // The partner without an account and the suspended one are skipped again — never claimed.
  expect((await again.json()).windowNotices).toMatchObject({ claimed: 0, mailed: 0, skipped: 2 });
  expect(await deliveries()).toHaveLength(1);
});
