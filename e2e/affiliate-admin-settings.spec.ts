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
  for (const label of ['owner', 'observer', 'rep', 'progadmin']) emails.push(uniqueEmail(`aff-${label}`));
  await seedUser(emails[0], PW, 'ADMIN', 'Org Admin', { orgId });
  const observer = await seedUser(emails[1], PW, 'ADMIN', 'Observer Admin', { orgId });
  await prisma.user.update({ where: { id: observer.id }, data: { adminLevel: 'OBSERVER' } });
  await seedUser(emails[2], PW, 'MENTOR', 'Sales Rep', { orgId });
  const prog = await seedUser(emails[3], PW, 'ADMIN', 'Program Admin', { orgId });
  await prisma.user.update({ where: { id: prog.id }, data: { adminLevel: 'PROGRAM_ADMIN' } });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId, code: 'adm-1', displayName: 'Admin Spec Partner' } })).id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  if (orgId) {
    const where = { orgId };
    await prisma.affiliateCommission.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePayout.deleteMany({ where }).catch(() => {});
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
  // A PROGRAM_ADMIN's reach is its cohort/company grants; affiliate data is neither (docs).
  const prog = await as(playwright, baseURL, emails[3]);
  for (const path of ['settings', 'partners', 'payments', 'commissions', 'payouts']) {
    expect((await prog.get(`/api/admin/affiliate/${path}`, { headers: host })).status(), path).toBe(403);
  }
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
  expect((await patch(partnerId, { status: 'ACTIVE' })).status()).toBe(200);
  // Termination: a real calendar day only, and final.
  const other = await prisma.affiliatePartner.findFirstOrThrow({ where: { orgId, code: 'new-1' } });
  expect((await patch(other.id, { status: 'TERMINATED', noticeEffectiveOn: '2026-02-31' })).status()).toBe(400);
  expect((await patch(other.id, { status: 'TERMINATED', noticeEffectiveOn: '2026-04-01' })).status()).toBe(200);
  expect((await prisma.affiliatePartner.findUniqueOrThrow({ where: { id: other.id } })).noticeEffectiveAt?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  for (const status of ['ACTIVE', 'SUSPENDED', 'TERMINATED']) {
    const res = await patch(other.id, { status, noticeEffectiveOn: '2026-05-01' });
    expect([res.status(), (await res.json()).code], status).toEqual([409, 'invalid_transition']);
  }
  expect((await observer.patch(`/api/admin/affiliate/partners/${partnerId}`, { headers: host, data: { status: 'SUSPENDED' } })).status()).toBe(403);
  expect((await patch('no-such-partner', { status: 'ACTIVE' })).status()).toBe(404);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.partner.state' } })).toBe(3); // suspend, reactivate, terminate — refusals leave none

  // The full IBAN: the paying admin only, and every reveal audited. (A published example IBAN.)
  await setPayoutDetails({ orgId, partnerId, details: { iban: 'DE89370400440532013000', holder: 'Admin Spec Partner' }, actor: { id: 'e2e', role: 'ADMIN' } });
  expect((await observer.get(`/api/admin/affiliate/partners/${partnerId}/payout-details`, { headers: host })).status()).toBe(403);
  const revealed = await owner.get(`/api/admin/affiliate/partners/${partnerId}/payout-details`, { headers: host });
  expect(await revealed.json()).toEqual({ details: { iban: 'DE89370400440532013000', holder: 'Admin Spec Partner' } });
  const audit = await prisma.auditLog.findMany({ where: { orgId, action: 'affiliate.payout_details.read' } });
  expect(audit).toHaveLength(1);
  expect(audit[0].detail).not.toContain('DE89370400440532013000');
});

test('payments: recorded by the one writer through the admin API, refusals carry their codes', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails[0]);
  const observer = await as(playwright, baseURL, emails[1]);
  const post = (ctx: APIRequestContext, data: unknown) => ctx.post('/api/admin/affiliate/payments', { headers: host, data });
  const base = { partnerId, customerExternalRef: 'c-9', amountMinor: 2_500, receivedOn: '2026-03-10', externalPaymentRef: 'inv-90' };

  expect((await post(observer, base)).status()).toBe(403);
  const ok = await post(owner, base);
  expect(ok.status()).toBe(201);
  expect(await ok.json()).toMatchObject({ partnerId, created: 1 });
  const code = async (data: unknown) => (await (await post(owner, data)).json()).code;
  expect(await code(base)).toBe('duplicate_payment');
  expect(await code({ ...base, externalPaymentRef: 'inv-91', receivedOn: '2999-01-01' })).toBe('invalid_input');
  expect(await code({ ...base, partnerId: null, customerExternalRef: 'c-new', externalPaymentRef: 'inv-92' })).toBe('unknown_customer');
  expect(await code({ ...base, amountMinor: 0, externalPaymentRef: 'inv-93' })).toBe('invalid_input');
  expect(await code({ ...base, receivedOn: '2026-02-31', externalPaymentRef: 'inv-95' })).toBe('invalid_input'); // never rolled into March

  // A known customer needs no partner; the list shows the commission the plan gave.
  expect((await post(owner, { ...base, partnerId: null, externalPaymentRef: 'inv-94', receivedOn: '2026-03-11' })).status()).toBe(201);
  const list = await (await observer.get('/api/admin/affiliate/payments', { headers: host })).json();
  expect(list.canWrite).toBe(false);
  const mine = list.rows.filter((r: { customerRef: string }) => r.customerRef === 'c-9');
  expect(mine.map((r: { externalPaymentRef: string }) => r.externalPaymentRef)).toEqual(['inv-94', 'inv-90']); // newest first
  expect(mine[1].commission).toMatchObject({ kind: 'PERCENT', status: 'PENDING' }); // the partner switched at customer 2
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.payment.record', actorId: { not: 'system' } } })).toBe(2);
});

test('commissions: approve / reject / un-approve under the lock, PAID untouchable, drift read only', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails[0]);
  const observer = await as(playwright, baseURL, emails[1]);
  const move = (ctx: APIRequestContext, ids: string[], transition: string) =>
    ctx.post('/api/admin/affiliate/commissions/transition', { headers: host, data: { ids, transition } });
  const byRef = async (ref: string) =>
    prisma.affiliateCommission.findFirstOrThrow({ where: { orgId, payment: { externalPaymentRef: ref } }, select: { id: true, status: true } });

  const pending = await (await observer.get('/api/admin/affiliate/commissions?status=PENDING', { headers: host })).json();
  expect(pending.canWrite).toBe(false);
  expect(pending.totals.PENDING.count).toBe(pending.total);
  const v1 = await byRef('inv-1'); // the v1 tier, frozen by the plan change but still PENDING
  const p90 = await byRef('inv-90');
  expect((await move(observer, [v1.id], 'APPROVE')).status()).toBe(403);

  expect(await (await move(owner, [v1.id, 'not-a-commission'], 'APPROVE')).json()).toEqual({ moved: 1, skipped: ['not-a-commission'], failedPartners: 0 });
  expect((await byRef('inv-1')).status).toBe('APPROVED');
  expect(await (await move(owner, [v1.id], 'REJECT')).json()).toEqual({ moved: 0, skipped: [v1.id], failedPartners: 0 }); // not PENDING any more
  expect(await (await move(owner, [v1.id], 'UNAPPROVE')).json()).toMatchObject({ moved: 1 });
  expect(await (await move(owner, [p90.id], 'REJECT')).json()).toMatchObject({ moved: 1 });

  // A PAID row never moves.
  await prisma.affiliateCommission.update({ where: { id: v1.id }, data: { status: 'PAID', paidAt: new Date() } });
  for (const tr of ['APPROVE', 'REJECT', 'UNAPPROVE']) expect((await (await move(owner, [v1.id], tr)).json()).moved).toBe(0);
  await prisma.affiliateCommission.update({ where: { id: v1.id }, data: { status: 'PENDING', paidAt: null } });

  expect(await prisma.auditLog.count({ where: { orgId, action: { startsWith: 'affiliate.commission.' } } })).toBe(3);

  // The v1 tier (300) disagrees with plan v2 (450): reported, not changed.
  const drift = (await (await observer.get('/api/admin/affiliate/commissions/drift', { headers: host })).json()).drift;
  expect(drift).toEqual(expect.arrayContaining([expect.objectContaining({ commissionId: v1.id, planVersion: 1, expected: { kind: 'TIER', amountMinor: 450 } })]));
  expect((await prisma.affiliateCommission.findUniqueOrThrow({ where: { id: v1.id } })).amountMinor).toBe(300);
});

test('payouts: all or nothing under the lock, only APPROVED rows of that partner', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const owner = await as(playwright, baseURL, emails[0]);
  const observer = await as(playwright, baseURL, emails[1]);
  const byRef = async (ref: string) => prisma.affiliateCommission.findFirstOrThrow({ where: { orgId, payment: { externalPaymentRef: ref } } });
  const v1 = await byRef('inv-1');
  const p94 = await byRef('inv-94');
  const p90 = await byRef('inv-90'); // REJECTED in the previous test
  await owner.post('/api/admin/affiliate/commissions/transition', { headers: host, data: { ids: [v1.id, p94.id], transition: 'APPROVE' } });
  const pay = (ctx: APIRequestContext, data: Record<string, unknown>) =>
    ctx.post('/api/admin/affiliate/payouts', { headers: host, data: { partnerId, paidOn: '2026-04-02', reference: 'bank-1', ...data } });

  expect((await pay(observer, { commissionIds: [v1.id] })).status()).toBe(403);
  // One rejected row in the batch: nothing is paid.
  expect(await (await pay(owner, { commissionIds: [v1.id, p90.id] })).json()).toEqual({ code: 'payout_mismatch' });
  expect((await byRef('inv-1')).status).toBe('APPROVED');
  // Another partner's batch, a future date: refused.
  const other = await prisma.affiliatePartner.findFirstOrThrow({ where: { orgId, code: 'new-1' } });
  expect(await (await pay(owner, { partnerId: other.id, commissionIds: [v1.id] })).json()).toEqual({ code: 'payout_mismatch' });
  expect((await pay(owner, { commissionIds: [v1.id], paidOn: '2999-01-01' })).status()).toBe(400);
  expect((await pay(owner, { commissionIds: [v1.id], paidOn: '2026-04-31' })).status()).toBe(400);

  // The payer's list is unpaged, with the totals of all approved rows.
  const cand = await (await owner.get(`/api/admin/affiliate/payouts/candidates?partnerId=${partnerId}`, { headers: host })).json();
  expect(cand).toMatchObject({ totalCount: 2, totalAmountMinor: v1.amountMinor + p94.amountMinor, max: 200 });
  expect(cand.rows.map((r: { id: string }) => r.id).sort()).toEqual([v1.id, p94.id].sort());
  expect((await observer.get(`/api/admin/affiliate/payouts/candidates?partnerId=${partnerId}`, { headers: host })).status()).toBe(403);

  const ok = await pay(owner, { commissionIds: [v1.id, p94.id] });
  expect(ok.status()).toBe(201);
  const body = await ok.json();
  expect(body).toMatchObject({ amountMinor: v1.amountMinor + p94.amountMinor, currency: 'EUR', count: 2 });
  for (const ref of ['inv-1', 'inv-94']) {
    const c = await byRef(ref);
    expect([c.status, c.payoutId, c.paidAt?.toISOString()]).toEqual(['PAID', body.payoutId, '2026-04-02T00:00:00.000Z']);
  }
  // Paying the same rows twice: nothing left to pay.
  expect(await (await pay(owner, { commissionIds: [v1.id] })).json()).toEqual({ code: 'payout_mismatch' });

  const list = await (await observer.get('/api/admin/affiliate/payouts', { headers: host })).json();
  expect(list.rows[0]).toMatchObject({ id: body.payoutId, amountMinor: body.amountMinor, reference: 'bank-1', commissions: 2 });
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.payout.create' } })).toBe(1);
  const partners = (await (await owner.get('/api/admin/affiliate/partners', { headers: host })).json()).partners;
  expect(partners.find((p: { id: string }) => p.id === partnerId).totals.PAID).toBe(body.amountMinor);
});

