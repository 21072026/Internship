import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * The affiliate programme end to end, through its real doors only (Story #3111):
 * a MARKETING admin sets the plan and the contract, creates two partners and
 * invites one; the partner registers and accepts the contract; the admin records
 * a referred customer's payment, approves the commission and records the payout;
 * the partner reads it in the portal — and another partner's payout is 404.
 * @smoke: the story's acceptance path.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org; invented codes and amounts.
 */

const PW = 'AffE2E123!';
const host = asHost(MARKETING_HOST);
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 100_000, commissionMinor: 2_500 }],
  topCommissionMinor: 5_000,
  percentBps: 1_000,
  switchAtCustomer: null,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};
let orgId = '';
let adminEmail = '';
let partnerEmail = '';
let otherEmail = '';
const contexts: APIRequestContext[] = [];

type Factory = { request: { newContext: (o: { baseURL?: string; maxRedirects?: number }) => Promise<APIRequestContext> } };
async function context(playwright: Factory, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  return ctx;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-e2e-${stamp}`, vertical: 'MARKETING' } })).id;
  adminEmail = uniqueEmail('aff-e2e-admin');
  partnerEmail = uniqueEmail('aff-e2e-partner');
  otherEmail = uniqueEmail('aff-e2e-other');
  await seedUser(adminEmail, PW, 'ADMIN', 'Programme Admin', { orgId });
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
    await prisma.invitationToken.deleteMany({ where: { orgId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId } }).catch(() => {});
  }
  for (const e of [adminEmail, partnerEmail, otherEmail]) if (e) await cleanupByEmail(e);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('partner → customer → payment → commission → payout, seen by the partner only', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const call = (method: 'POST' | 'PUT', url: string, data: unknown) => admin.fetch(url, { method, headers: host, data });

  // The programme: plan and contract.
  expect((await call('PUT', '/api/admin/affiliate/settings/plan', PLAN)).status()).toBe(200);
  expect((await call('PUT', '/api/admin/affiliate/settings/contract', { texts: { en: 'Synthetic partner terms.' } })).status()).toBe(200);

  // Two partners; the first is invited and opens its account.
  const mine = (await (await call('POST', '/api/admin/affiliate/partners', { code: 'e2e-1', displayName: 'First Partner', contactEmail: partnerEmail })).json()).id;
  const theirs = (await (await call('POST', '/api/admin/affiliate/partners', { code: 'e2e-2', displayName: 'Second Partner', contactEmail: otherEmail })).json()).id;
  expect((await call('POST', `/api/admin/affiliate/partners/${mine}/invite`, {})).status()).toBe(201);
  const token = (await prisma.invitationToken.findFirstOrThrow({ where: { orgId, partnerId: mine, revokedAt: null } })).token;
  const anon = await context(playwright, baseURL);
  const registered = await anon.post('/api/register', {
    headers: { ...host, ...freshIp('register affiliate-e2e') },
    data: { token, email: partnerEmail, password: PW, fullName: 'First Partner', consent: true },
  });
  expect(registered.status()).toBe(201);

  const partner = await context(playwright, baseURL);
  expect((await signInViaApi(partner, partnerEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(409); // contract first
  expect((await partner.post('/api/affiliate/contract', { headers: host, data: { version: 1 } })).status()).toBe(200);
  expect((await partner.get('/api/affiliate/me', { headers: host })).status()).toBe(200);

  // A referred customer pays; the commission follows from the plan.
  const pay = (partnerId: string, customer: string, ref: string) =>
    call('POST', '/api/admin/affiliate/payments', { partnerId, customerExternalRef: customer, amountMinor: 9_900, receivedOn: '2026-09-01', externalPaymentRef: ref });
  expect((await pay(mine, 'E2E-CUST-1', 'E2E-INV-1')).status()).toBe(201);
  expect((await pay(theirs, 'E2E-CUST-2', 'E2E-INV-2')).status()).toBe(201);
  const commission = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId, partnerId: mine }, select: { id: true, amountMinor: true, status: true } });
  expect(commission).toMatchObject({ amountMinor: 2_500, status: 'PENDING' });
  const other = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId, partnerId: theirs }, select: { id: true } });

  // Approve and pay out — both partners, so the second one has a payout to hide.
  expect((await call('POST', '/api/admin/affiliate/commissions/transition', { ids: [commission.id, other.id], transition: 'APPROVE' })).status()).toBe(200);
  const payout = await call('POST', '/api/admin/affiliate/payouts', { partnerId: mine, commissionIds: [commission.id], paidOn: '2026-09-20', reference: 'E2E-TRX-1' });
  expect(payout.status()).toBe(201);
  const myPayout = (await payout.json()).payoutId;
  const theirPayout = (await (await call('POST', '/api/admin/affiliate/payouts', { partnerId: theirs, commissionIds: [other.id], paidOn: '2026-09-20', reference: 'E2E-TRX-2' })).json()).payoutId;
  expect((await prisma.affiliateCommission.findUniqueOrThrow({ where: { id: commission.id } })).status).toBe('PAID');

  // The partner's portal: its own payout, never the other one.
  const own = await partner.get(`/affiliate/payouts/${myPayout}`, { headers: host });
  expect(own.status()).toBe(200);
  expect(await own.text()).toContain('E2E-TRX-1');
  const foreign = await partner.get(`/affiliate/payouts/${theirPayout}`, { headers: host });
  expect(foreign.status()).toBe(404);
  expect(await foreign.text()).not.toContain('E2E-TRX-2');
  const list = await (await partner.get('/affiliate/payouts', { headers: host })).text();
  expect(list).toContain('E2E-TRX-1');
  expect(list).not.toContain('E2E-TRX-2');
  const customers = await (await partner.get('/affiliate/customers', { headers: host })).text();
  expect(customers).toContain('E2E-CUST-1');
  expect(customers).not.toContain('E2E-CUST-2');

  // And none of the admin API answers the partner.
  expect((await partner.get('/api/admin/affiliate/payouts', { headers: host })).status()).toBe(403);
});
