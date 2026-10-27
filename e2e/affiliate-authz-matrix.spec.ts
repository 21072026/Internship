import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, signInAndSettle, gotoSettled, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { AffiliateWriteError, createPayout, recordAffiliatePayment } from '../src/lib/affiliatePaymentWriter';

/**
 * The affiliate admin API across tenants and tiers, and two money guards (#3119).
 *
 * - An ORG_ADMIN of organisation A, given organisation B's ids, changes nothing of
 *   B's: every write by id answers like an id that does not exist (or skips it).
 * - A PROGRAM_ADMIN holds no affiliate permission: every admin write is 403. The
 *   list of writes is read from the route files, so a new one is covered.
 * - After a termination takes effect a partner gets no NEW customer; a payout is
 *   never dated before what it pays accrued.
 * - The commissions screen asks before moving money and checks drift on request.
 * @smoke: tenant and permission boundaries on money.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs, invented codes and amounts.
 */

const PW = 'AffMatrix123!';
const host = asHost(MARKETING_HOST);
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 100_000, commissionMinor: 1_000 }],
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
let orgA = '';
let orgB = '';
let ownerA = '';
let programA = '';
const b = { partner: '', commission: '', payout: '' };

const ROOT = path.join(__dirname, '..', 'src', 'app', 'api', 'admin', 'affiliate');
function adminWrites(): { url: string; method: string }[] {
  const out: { url: string; method: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'route.ts') {
        const url = '/api/admin/affiliate/' + path.relative(ROOT, d).split(path.sep).filter(Boolean).map((s) => (s.startsWith('[') ? 'x' : s)).join('/');
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/export async function (POST|PUT|PATCH|DELETE)\b/g)) out.push({ url: url.replace(/\/$/, ''), method: m[1] });
      }
    }
  };
  walk(ROOT);
  return out;
}

async function newOrg(label: string) {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const id = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-mx-${label}-${stamp}`, vertical: 'MARKETING' } })).id;
  orgIds.push(id);
  await prisma.affiliateProgramSettings.create({ data: { orgId: id, plan: PLAN, planVersion: 1, planEffectiveAt: new Date('2026-01-01T00:00:00Z') } });
  return id;
}
async function admin(org: string, level: 'ORG_ADMIN' | 'PROGRAM_ADMIN' = 'ORG_ADMIN') {
  const email = uniqueEmail(`aff-mx-${level.toLowerCase()}`);
  emails.push(email);
  const u = await seedUser(email, PW, 'ADMIN', 'Matrix Admin', { orgId: org });
  if (level !== 'ORG_ADMIN') await prisma.user.update({ where: { id: u.id }, data: { adminLevel: level } });
  return email;
}
async function signedIn(playwright: { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } }, baseURL: string | undefined, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
  return ctx;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgA = await newOrg('a');
  orgB = await newOrg('b');
  ownerA = await admin(orgA);
  programA = await admin(orgA, 'PROGRAM_ADMIN');

  // Organisation B: a partner with an approved and a paid commission.
  b.partner = (await prisma.affiliatePartner.create({ data: { orgId: orgB, code: 'mx-b', displayName: 'Other Org Partner', contactEmail: uniqueEmail('aff-mx-b') } })).id;
  await recordAffiliatePayment({ orgId: orgB, partnerId: b.partner, customerExternalRef: 'MX-B-1', amountMinor: 5_000, currency: 'EUR', receivedAt: new Date('2026-03-01T00:00:00Z'), externalPaymentRef: 'MX-B-INV-1', source: 'MANUAL' });
  await recordAffiliatePayment({ orgId: orgB, partnerId: b.partner, customerExternalRef: 'MX-B-2', amountMinor: 5_000, currency: 'EUR', receivedAt: new Date('2026-03-02T00:00:00Z'), externalPaymentRef: 'MX-B-INV-2', source: 'MANUAL' });
  const rows = await prisma.affiliateCommission.findMany({ where: { orgId: orgB }, orderBy: { accruedAt: 'asc' }, select: { id: true } });
  await prisma.affiliateCommission.updateMany({ where: { orgId: orgB }, data: { status: 'APPROVED' } });
  b.commission = rows[0].id;
  b.payout = (await createPayout(orgB, { partnerId: b.partner, commissionIds: [rows[1].id], paidAt: new Date('2026-03-10T00:00:00Z') }, 'system')).payoutId;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  for (const id of orgIds) {
    await prisma.affiliateCommission.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePayout.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.invitationToken.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  for (const e of emails) await cleanupByEmail(e);
  for (const id of orgIds) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test("an admin of another organisation changes nothing of B's", { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const a = await signedIn(playwright, baseURL, ownerA);
  const snapshot = async () => ({
    partner: await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: b.partner }, select: { status: true, userId: true } }),
    commissions: await prisma.affiliateCommission.findMany({ where: { orgId: orgB }, orderBy: { id: 'asc' }, select: { id: true, status: true, payoutId: true } }),
    payments: await prisma.affiliatePayment.count({ where: { orgId: orgB } }),
    payouts: await prisma.affiliatePayout.count({ where: { orgId: orgB } }),
    invitations: await prisma.invitationToken.count({ where: { orgId: orgB } }),
  });
  const before = await snapshot();

  expect((await a.patch(`/api/admin/affiliate/partners/${b.partner}`, { headers: host, data: { status: 'SUSPENDED' } })).status()).toBe(404);
  expect((await a.get(`/api/admin/affiliate/partners/${b.partner}/payout-details`, { headers: host })).status()).toBe(404);
  expect((await a.post(`/api/admin/affiliate/partners/${b.partner}/invite`, { headers: host })).status()).toBe(404);
  const pay = await a.post('/api/admin/affiliate/payments', {
    headers: host,
    data: { partnerId: b.partner, customerExternalRef: 'MX-A-X', amountMinor: 1_000, receivedOn: '2026-03-05', externalPaymentRef: 'MX-A-INV-X' },
  });
  expect(pay.status()).toBe(404);
  const move = await a.post('/api/admin/affiliate/commissions/transition', { headers: host, data: { ids: [b.commission], transition: 'REJECT' } });
  expect((await move.json()).moved).toBe(0);
  expect((await a.post('/api/admin/affiliate/payouts', { headers: host, data: { partnerId: b.partner, commissionIds: [b.commission], paidOn: '2026-03-20' } })).status()).toBe(404);

  expect(await snapshot()).toEqual(before);
});

test('a PROGRAM_ADMIN holds no affiliate write', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const writes = adminWrites();
  expect(writes.length).toBeGreaterThanOrEqual(10);
  const prog = await signedIn(playwright, baseURL, programA);
  for (const w of writes) {
    const res = await prog.fetch(w.url, { method: w.method, headers: host, data: {} });
    expect(res.status(), `${w.method} ${w.url}`).toBe(403);
  }
});

test('a terminated partner gets no new customer; a payout is never dated before its commissions', { tag: '@smoke' }, async () => {
  const ended = (await prisma.affiliatePartner.create({ data: { orgId: orgA, code: 'mx-end', displayName: 'Ended', status: 'TERMINATED', noticeEffectiveAt: new Date('2026-06-01T00:00:00Z') } })).id;
  const pay = (customer: string, ref: string, day: string) =>
    recordAffiliatePayment({ orgId: orgA, partnerId: ended, customerExternalRef: customer, amountMinor: 3_000, currency: 'EUR', receivedAt: new Date(`${day}T00:00:00Z`), externalPaymentRef: ref, source: 'MANUAL' });
  // Referred before the termination took effect: its later payments still record (RUN_OUT).
  await pay('MX-END-OLD', 'MX-END-1', '2026-05-01');
  await pay('MX-END-OLD', 'MX-END-2', '2026-07-01');
  // A new customer after it: refused, and nothing is tied to the ended partnership.
  await expect(pay('MX-END-NEW', 'MX-END-3', '2026-07-02')).rejects.toMatchObject({ code: 'partner_terminated' });
  expect(await prisma.affiliateCustomer.count({ where: { orgId: orgA, externalRef: 'MX-END-NEW' } })).toBe(0);

  const live = (await prisma.affiliatePartner.create({ data: { orgId: orgA, code: 'mx-live', displayName: 'Live' } })).id;
  await recordAffiliatePayment({ orgId: orgA, partnerId: live, customerExternalRef: 'MX-LIVE-1', amountMinor: 3_000, currency: 'EUR', receivedAt: new Date('2026-04-15T00:00:00Z'), externalPaymentRef: 'MX-LIVE-INV-1', source: 'MANUAL' });
  const c = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId: orgA, partnerId: live } });
  await prisma.affiliateCommission.update({ where: { id: c.id }, data: { status: 'APPROVED' } });
  const early = createPayout(orgA, { partnerId: live, commissionIds: [c.id], paidAt: new Date('2025-04-15T00:00:00Z') }, 'system');
  await expect(early).rejects.toBeInstanceOf(AffiliateWriteError);
  await expect(early).rejects.toMatchObject({ code: 'payout_before_accrual' });
  // The same day is fine.
  expect((await createPayout(orgA, { partnerId: live, commissionIds: [c.id], paidAt: new Date('2026-04-15T00:00:00Z') }, 'system')).count).toBe(1);
});

test('the commissions screen confirms a move with its count and sum, and checks drift on request', async ({ page }) => {
  const p = (await prisma.affiliatePartner.create({ data: { orgId: orgA, code: 'mx-ui', displayName: 'Screen' } })).id;
  await recordAffiliatePayment({ orgId: orgA, partnerId: p, customerExternalRef: 'MX-UI-1', amountMinor: 3_000, currency: 'EUR', receivedAt: new Date('2026-05-01T00:00:00Z'), externalPaymentRef: 'MX-UI-INV-1', source: 'MANUAL' });

  await page.context().setExtraHTTPHeaders(asHost(MARKETING_HOST));
  await signInAndSettle(page, ownerA, PW, '/admin');
  let driftCalls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/admin/affiliate/commissions/drift')) driftCalls += 1;
  });
  await gotoSettled(page, '/admin/affiliates/commissions');
  await expect(page.getByTestId('affiliate-drift-check')).toBeVisible();
  expect(driftCalls).toBe(0);

  await page.getByRole('checkbox').nth(1).check();
  await page.getByTestId('affiliate-commission-REJECT').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 commission(s)');
  await expect(dialog).toContainText('cannot be restored');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await prisma.affiliateCommission.count({ where: { orgId: orgA, partnerId: p, status: 'REJECTED' } })).toBe(0);

  await page.getByTestId('affiliate-drift-check').click();
  await expect(page.getByTestId('affiliate-drift-none')).toBeVisible();
  expect(driftCalls).toBe(1);
});
