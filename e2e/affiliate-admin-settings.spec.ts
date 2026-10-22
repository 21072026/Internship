import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { prisma as appPrisma } from '../src/lib/prisma';
import { recordAffiliatePayment } from '../src/lib/affiliatePaymentWriter';

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
