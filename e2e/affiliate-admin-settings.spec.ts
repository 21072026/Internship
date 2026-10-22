import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { recordAffiliatePayment, AffiliateWriteError } from '../src/lib/affiliatePaymentWriter';
import { setPayoutDetails } from '../src/lib/affiliatePayoutDetails';

/**
 * The programme settings API (docs/affiliate-module.md, #3116): who may read and
 * write them, and what a plan change does. @smoke: a money boundary.
 *
 * - `affiliate.read` for every admin tier, `affiliate.write` for ORG_ADMIN only;
 *   the form gets `canWrite` from the same rule.
 * - A real plan change bumps the version and re-evaluates every partner; an
 *   unchanged save is a no-op; a malformed plan names its fields; a currency the
 *   programme does not offer is refused (EUR only for now).
 * - Publishing the contract through the API bumps its version on a real change.
 *
 * SYNTHETIC ONLY: a throwaway MARKETING org per run.
 */

const PW = 'AffAdmin123!';
const host = asHost(MARKETING_HOST);
const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 1_000, commissionMinor: 300 }],
  topCommissionMinor: 900,
  percentBps: 1_000,
  switchAtCustomer: 2,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 7,
  afterNotice: 'RUN_OUT',
};

let orgId = '';
let partnerId = '';
const emails: string[] = [];
const contexts: APIRequestContext[] = [];

test.describe.configure({ mode: 'serial' });

type RequestFactory = { request: { newContext: (o: { baseURL?: string }) => Promise<APIRequestContext> } };
async function as(playwright: RequestFactory, baseURL: string | undefined, email: string) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW, { host: MARKETING_HOST })).ok, `${email} sign-in`).toBe(true);
  return ctx;
}

test.beforeAll(async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-admin-${stamp}`, vertical: 'MARKETING' } })).id;
  for (const label of ['owner', 'observer', 'rep']) emails.push(uniqueEmail(`aff-${label}`));
  await seedUser(emails[0], PW, 'ADMIN', 'Org Admin', { orgId });
  const observer = await seedUser(emails[1], PW, 'ADMIN', 'Observer Admin', { orgId });
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  await seedUser(emails[2], PW, 'MENTOR', 'Sales Rep', { orgId });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: 'adm-1', displayName: 'Admin Spec Partner' } })).id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (orgId) {
    const where = { orgId };
    await prisma.affiliateCommission.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where }).catch(() => {});
  }
  for (const e of emails) await cleanupByEmail(e);
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

test('read for every admin tier, write for the organisation admin only', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails[0]);
  const observer = await as(playwright, baseURL, emails[1]);
  const rep = await as(playwright, baseURL, emails[2]);

  const own = await owner.get('/api/admin/affiliate/settings', { headers: host });
  expect(own.status()).toBe(200);
  expect(await own.json()).toMatchObject({ plan: null, planVersion: 0, contractVersion: 0, canWrite: true, currencies: ['EUR'] });

  const obs = await observer.get('/api/admin/affiliate/settings', { headers: host });
  expect(obs.status()).toBe(200);
  expect((await obs.json()).canWrite).toBe(false);
  expect((await observer.put('/api/admin/affiliate/settings/plan', { headers: host, data: PLAN })).status()).toBe(403);
  expect((await observer.put('/api/admin/affiliate/settings/contract', { headers: host, data: { texts: { en: 'x' } } })).status()).toBe(403);

  expect((await rep.get('/api/admin/affiliate/settings', { headers: host })).status()).toBe(403);
});

test('a plan is validated, versioned only on a real change, and re-evaluates partners', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails[0]);
  const put = (data: unknown) => owner.put('/api/admin/affiliate/settings/plan', { headers: host, data });

  const bad = await put({ ...PLAN, percentBps: 20_000, tiers: [{ upToMinor: 5, commissionMinor: 1 }, { upToMinor: 5, commissionMinor: 1 }] });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).issues.map((i: { field: string }) => i.field).sort()).toEqual(['percentBps', 'tiers.1.upToMinor']);
  expect((await put({ ...PLAN, currency: 'USD' })).status()).toBe(400); // EUR only for now

  const first = await put(PLAN);
  expect(first.status()).toBe(200);
  expect(await first.json()).toMatchObject({ changed: true, planVersion: 1, partnersResynced: 1 });
  expect(await (await put(PLAN)).json()).toMatchObject({ changed: false, planVersion: 1 });

  // A payment under v1, then a richer v2: the existing commission is frozen (drift), never changed.
  await recordAffiliatePayment({ orgId, partnerId, customerExternalRef: 'c-1', amountMinor: 800, currency: 'EUR', receivedAt: new Date('2026-03-01T10:00:00Z'), externalPaymentRef: 'inv-1', source: 'MANUAL' });
  const second = await put({ ...PLAN, tiers: [{ upToMinor: 1_000, commissionMinor: 450 }] });
  expect(await second.json()).toMatchObject({ changed: true, planVersion: 2, partnersResynced: 1, drift: 1 });
  const commission = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId } });
  expect([commission.amountMinor, commission.planVersion]).toEqual([300, 1]);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.plan.update' } })).toBe(2);
});

test('the contract is published through the API', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails[0]);
  const put = (texts: unknown) => owner.put('/api/admin/affiliate/settings/contract', { headers: host, data: { texts } });
  expect((await put({})).status()).toBe(400);
  expect(await (await put({ en: 'Synthetic terms', de: 'Synthetische Bedingungen' })).json()).toEqual({ changed: true, version: 1 });
  expect(await (await put({ de: 'Synthetische Bedingungen', en: 'Synthetic terms' })).json()).toEqual({ changed: false, version: 1 });
  const s = await (await owner.get('/api/admin/affiliate/settings', { headers: host })).json();
  expect(s).toMatchObject({ contractVersion: 1, contract: { en: 'Synthetic terms', de: 'Synthetische Bedingungen' } });
});

test('partners: create, codes unique, state changes under the lock, IBAN reveal audited', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails[0]);
  const observer = await as(playwright, baseURL, emails[1]);
  const post = (ctx: APIRequestContext, data: unknown) => ctx.post('/api/admin/affiliate/partners', { headers: host, data });

  expect((await post(observer, { code: 'obs-1', displayName: 'Nope' })).status()).toBe(403);
  const bad = await post(owner, { code: 'has space', displayName: '', contactEmail: 'not-an-email' });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).issues.sort()).toEqual(['code', 'contactEmail', 'displayName']);
  const created = await post(owner, { code: 'new-1', displayName: 'New Partner', contactEmail: 'New.Partner@Example.test' });
  expect(created.status()).toBe(201);
  const newId = (await created.json()).id;
  expect((await post(owner, { code: 'NEW-1', displayName: 'Same code, other case' })).status()).toBe(409);

  const list = await (await observer.get('/api/admin/affiliate/partners', { headers: host })).json();
  expect(list.canWrite).toBe(false);
  const row = list.partners.find((p: { id: string }) => p.id === newId);
  expect(row).toMatchObject({ code: 'new-1', contactEmail: 'new.partner@example.test', status: 'ACTIVE', hasAccount: false, customers: 0 });
  // The earlier spec's partner carries its PENDING commission in the totals, summed in SQL.
  expect(list.partners.find((p: { id: string }) => p.id === partnerId).totals).toEqual({ PENDING: 300, APPROVED: 0, PAID: 0 });

  // Suspension: no new payments. Termination needs a date and re-evaluates.
  const patch = (id: string, data: unknown) => owner.patch(`/api/admin/affiliate/partners/${id}`, { headers: host, data });
  expect((await patch(partnerId, { status: 'SUSPENDED' })).status()).toBe(200);
  await expect(
    recordAffiliatePayment({ orgId, partnerId, customerExternalRef: 'c-1', amountMinor: 800, currency: 'EUR', receivedAt: new Date('2026-03-05T00:00:00Z'), externalPaymentRef: 'inv-2', source: 'MANUAL' }),
  ).rejects.toBeInstanceOf(AffiliateWriteError);
  expect((await patch(partnerId, { status: 'TERMINATED' })).status()).toBe(400);
  expect((await patch(partnerId, { status: 'TERMINATED', noticeEffectiveAt: '2026-04-01T00:00:00.000Z' })).status()).toBe(200);
  expect((await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partnerId } })).noticeEffectiveAt?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  expect((await patch(partnerId, { status: 'ACTIVE' })).status()).toBe(200);
  expect((await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: partnerId } })).noticeEffectiveAt).toBeNull();
  expect((await observer.patch(`/api/admin/affiliate/partners/${partnerId}`, { headers: host, data: { status: 'SUSPENDED' } })).status()).toBe(403);
  expect((await patch('no-such-partner', { status: 'ACTIVE' })).status()).toBe(404);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.partner.state' } })).toBe(3); // suspend, terminate, reactivate — refusals leave none

  // The full IBAN: the paying admin only, and every reveal audited. (A published example IBAN.)
  await setPayoutDetails({ orgId, partnerId, details: { iban: 'DE89370400440532013000', holder: 'Admin Spec Partner' }, actor: { id: 'e2e', role: 'ADMIN' } });
  expect((await observer.get(`/api/admin/affiliate/partners/${partnerId}/payout-details`, { headers: host })).status()).toBe(403);
  const revealed = await owner.get(`/api/admin/affiliate/partners/${partnerId}/payout-details`, { headers: host });
  expect(await revealed.json()).toEqual({ details: { iban: 'DE89370400440532013000', holder: 'Admin Spec Partner' } });
  const audit = await prisma.auditLog.findMany({ where: { orgId, action: 'affiliate.payout_details.read' } });
  expect(audit).toHaveLength(1);
  expect(audit[0].detail).not.toContain('DE89370400440532013000');
});
