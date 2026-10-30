import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * Automatic affiliate attribution (#3354, docs/affiliate-module.md): an account
 * event whose `referral_code` names an ACTIVE partner of the SAME org links the
 * customer to that partner. Through the real doors only.
 *
 * THE FLOW (@smoke — the issue's four steps with synthetic names): the partner
 * has a code; the source system sends `account_created` with it; the partner's
 * customer list shows the account; the admin's later manual payment entry finds
 * the customer WITHOUT choosing a partner. A repeat of the event, a second event
 * of the account, a different code and a dry run all leave exactly one link.
 *
 * THE BOUNDARY (@smoke): another org's partner code never links; a suspended or
 * terminated partner's code never links; an unknown code writes nothing.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs, invented codes, `*.example` hosts,
 * currency EUR with invented amounts.
 */

const STAMP = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const SLUG = `e2e-attr-${STAMP}`;
const KEY_PREFIX = `e2e-attr-${STAMP}`;
const PW = 'AttrE2E123!';
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
const DAY = 24 * 60 * 60 * 1000;
const CODE = `demo-partner-${STAMP}`;
const FOREIGN_CODE = `foreign-partner-${STAMP}`;

let orgA = '';
let orgB = '';
let adminEmail = '';
let partnerEmail = '';
let writeKey = '';
let partnerId = '';
const emails: string[] = [];
const contexts: APIRequestContext[] = [];

type Factory = { request: { newContext: (o: { baseURL?: string; maxRedirects?: number }) => Promise<APIRequestContext> } };
async function context(playwright: Factory, baseURL: string | undefined) {
  const ctx = await playwright.request.newContext({ baseURL });
  contexts.push(ctx);
  return ctx;
}

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Attr ${label} ${STAMP}`, slug: `attr-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

const extId = () => `acct-${crypto.randomBytes(6).toString('hex')}`;
function envelope(over: Record<string, unknown> = {}) {
  return {
    event_id: `evt-${crypto.randomBytes(6).toString('hex')}`,
    schema_version: 1,
    event_type: 'account_created',
    occurred_at: new Date().toISOString(),
    external_id: extId(),
    trial_started_at: new Date(Date.now() - DAY).toISOString(),
    trial_ends_at: new Date(Date.now() + 19 * DAY).toISOString(),
    referral_code: CODE,
    contact: { first_name: 'Ada', last_name: 'Example', email: `ada-${crypto.randomBytes(3).toString('hex')}@shop.example`, company_name: `Shop ${STAMP} ${crypto.randomBytes(3).toString('hex')}` },
    ...over,
  };
}
const post = (request: APIRequestContext, body: unknown) =>
  request.post(`/api/integrations/${SLUG}/events`, { headers: { authorization: `Bearer ${writeKey}` }, data: body });
const postBatch = (request: APIRequestContext, body: unknown) =>
  request.post(`/api/integrations/${SLUG}/events/batch`, { headers: { authorization: `Bearer ${writeKey}` }, data: body });
const linksOf = (externalRef: string) => prisma.affiliateCustomer.findMany({ where: { externalRef: { in: [externalRef] } } });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgA = await marketingOrg('a');
  orgB = await marketingOrg('b');
  adminEmail = uniqueEmail('attr-admin');
  partnerEmail = uniqueEmail('attr-partner');
  const ownerEmail = uniqueEmail('attr-owner');
  emails.push(adminEmail, partnerEmail, ownerEmail);
  await seedUser(adminEmail, PW, 'ADMIN', 'Programme Admin', { orgId: orgA });
  const owner = await seedUser(ownerEmail, PW, 'MENTOR', 'Lead Owner', { orgId: orgA });
  await prisma.setting.create({ data: { orgId: orgA, key: 'defaultLeadOwnerId', value: owner.id } });
  await prisma.affiliateProgramSettings.create({ data: { orgId: orgA, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  // Another org's partner carries a code that org A has no partner for.
  await prisma.affiliatePartner.create({ data: { orgId: orgB, code: FOREIGN_CODE, displayName: 'Foreign Partner' } });
  await prisma.integrationSource.create({ data: { orgId: orgA, slug: SLUG, label: 'Attribution Feed' } });
  const raw = `icrm_${crypto.randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: { name: `${KEY_PREFIX}-w`, hashedKey: crypto.createHash('sha256').update(raw).digest('hex'), scopes: 'companies:write', orgId: orgA },
  });
  writeKey = raw;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  const orgIds = [orgA, orgB].filter(Boolean);
  if (orgIds.length) {
    const where = { orgId: { in: orgIds } };
    await prisma.affiliateCommission.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where }).catch(() => {});
    await prisma.affiliateContractAcceptance.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where }).catch(() => {});
    await prisma.invitationToken.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where }).catch(() => {});
    await prisma.integrationEvent.deleteMany({ where }).catch(() => {});
    await prisma.integrationSource.deleteMany({ where }).catch(() => {});
    await prisma.statusChange.deleteMany({ where: { relation: where } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where }).catch(() => {});
    await prisma.company.deleteMany({ where }).catch(() => {});
    await prisma.source.deleteMany({ where }).catch(() => {});
    await prisma.setting.deleteMany({ where }).catch(() => {});
    await prisma.activityLog.deleteMany({ where }).catch(() => {});
  }
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } }).catch(() => {});
  for (const e of emails) await cleanupByEmail(e);
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('referral link → account_created → partner sees the customer → payment needs no partner', { tag: '@smoke' }, async ({ playwright, baseURL, request }) => {
  const admin = await context(playwright, baseURL);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  const call = (method: 'POST' | 'PUT', url: string, data: unknown) => admin.fetch(url, { method, headers: host, data });

  // Step 1: the partner exists with a code, signs in, accepts the contract.
  expect((await call('PUT', '/api/admin/affiliate/settings/contract', { texts: { en: 'Synthetic partner terms.' } })).status()).toBe(200);
  partnerId = (await (await call('POST', '/api/admin/affiliate/partners', { code: CODE, displayName: 'Demo Partner', contactEmail: partnerEmail })).json()).id;
  expect((await call('POST', '/api/admin/affiliate/partners', { code: `second-${STAMP}`, displayName: 'Second Partner' })).status()).toBe(201);
  expect((await call('POST', `/api/admin/affiliate/partners/${partnerId}/invite`, {})).status()).toBe(201);
  const token = (await prisma.invitationToken.findFirstOrThrow({ where: { orgId: orgA, partnerId, revokedAt: null } })).token;
  const anon = await context(playwright, baseURL);
  const registered = await anon.post('/api/register', {
    headers: { ...host, ...freshIp('register attribution-e2e') },
    data: { token, email: partnerEmail, password: PW, fullName: 'Demo Partner', consent: true },
  });
  expect(registered.status()).toBe(201);
  const partner = await context(playwright, baseURL);
  expect((await signInViaApi(partner, partnerEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);
  expect((await partner.post('/api/affiliate/contract', { headers: host, data: { version: 1 } })).status()).toBe(200);

  // Step 3: the source system reports the sign-up with the partner's code.
  const body = envelope();
  const ext = body.external_id as string;
  expect(await (await partner.get('/affiliate/customers', { headers: host })).text()).not.toContain(ext);
  const first = await post(request, body);
  expect(first.status()).toBe(200);
  expect((await first.json()).outcome).toBe('applied');

  // Step 4: the partner's customer list shows it, and the row is the partner's.
  const rows = await linksOf(ext);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ orgId: orgA, partnerId });
  expect(await (await partner.get('/affiliate/customers', { headers: host })).text()).toContain(ext);

  // The same event again (duplicate), a later event of the account, a dry run
  // and a different partner's code: still exactly this one link.
  expect((await (await post(request, body)).json()).outcome).toBe('duplicate');
  expect((await post(request, envelope({ external_id: ext, event_type: 'trial_started' }))).status()).toBe(200);
  const second = await post(request, envelope({ external_id: ext, event_type: 'trial_started', referral_code: `second-${STAMP}` }));
  expect(second.status()).toBe(200);
  const dryEvent = envelope({ referral_code: CODE });
  const dry = await postBatch(request, { dry_run: true, events: [dryEvent] });
  expect(dry.status()).toBe(200);
  // The dry run really judged the event (it would apply), and wrote nothing.
  const dryBody = await dry.json();
  expect(dryBody.dry_run).toBe(true);
  expect(dryBody.results[0].outcome).toBe('applied');
  expect(await linksOf(dryEvent.external_id as string)).toHaveLength(0);
  expect(await prisma.company.count({ where: { orgId: orgA, externalId: dryEvent.external_id as string } })).toBe(0);
  const after = await linksOf(ext);
  expect(after).toHaveLength(1);
  expect(after[0].partnerId).toBe(partnerId); // first link wins
  expect(await prisma.affiliateCustomer.count({ where: { orgId: orgA } })).toBe(1); // the dry run linked nobody
  expect(await prisma.activityLog.count({ where: { orgId: orgA, action: 'integration.affiliate_kept_first' } })).toBeGreaterThanOrEqual(1);

  // The admin's manual payment entry names no partner and finds the customer.
  const paid = await call('POST', '/api/admin/affiliate/payments', {
    partnerId: null,
    customerExternalRef: ext,
    amountMinor: 9_900,
    receivedOn: '2026-09-01',
    externalPaymentRef: `E2E-ATTR-INV-${STAMP}`,
  });
  expect(paid.status()).toBe(201);
  const commission = await prisma.affiliateCommission.findFirstOrThrow({ where: { orgId: orgA }, select: { partnerId: true } });
  expect(commission.partnerId).toBe(partnerId);
});

test('another org\'s code, an unknown code, or a suspended / terminated partner never link', { tag: '@smoke' }, async ({ request }) => {
  const suspended = `suspended-${STAMP}`;
  const terminated = `terminated-${STAMP}`;
  await prisma.affiliatePartner.create({ data: { orgId: orgA, code: suspended, displayName: 'Suspended Partner', status: 'SUSPENDED' } });
  await prisma.affiliatePartner.create({ data: { orgId: orgA, code: terminated, displayName: 'Terminated Partner', status: 'TERMINATED', noticeEffectiveAt: new Date(Date.now() - DAY) } });
  const before = await prisma.affiliateCustomer.count({ where: { orgId: { in: [orgA, orgB] } } });

  for (const code of [FOREIGN_CODE, `nobody-${STAMP}`, suspended, terminated]) {
    const ext = extId();
    const res = await post(request, envelope({ external_id: ext, referral_code: code }));
    expect(res.status(), code).toBe(200);
    // The account itself is still created: only the affiliate link is withheld.
    expect((await res.json()).outcome, code).toBe('applied');
    expect(await linksOf(ext), code).toHaveLength(0);
  }
  expect(await prisma.affiliateCustomer.count({ where: { orgId: { in: [orgA, orgB] } } })).toBe(before);
  expect(await prisma.affiliateCustomer.count({ where: { orgId: orgB } })).toBe(0);
});

test('a terminated partner still links while its notice period runs; a 100-character code fits the envelope', { tag: '@smoke' }, async ({ request }) => {
  const notice = await prisma.affiliatePartner.create({
    data: { orgId: orgA, code: `in-notice-${STAMP}`, displayName: 'Notice Partner', status: 'TERMINATED', noticeEffectiveAt: new Date(Date.now() + 30 * DAY) },
    select: { id: true },
  });
  const ext = extId();
  expect((await post(request, envelope({ external_id: ext, referral_code: `in-notice-${STAMP}` }))).status()).toBe(200);
  const rows = await linksOf(ext);
  expect(rows).toHaveLength(1);
  expect(rows[0].partnerId).toBe(notice.id);

  const longCode = `L${'x'.repeat(99)}`;
  const longId = (await prisma.affiliatePartner.create({ data: { orgId: orgA, code: longCode, displayName: 'Long Code Partner' } })).id;
  const extLong = extId();
  const ok = await post(request, envelope({ external_id: extLong, referral_code: longCode }));
  expect(ok.status()).toBe(200);
  expect((await linksOf(extLong))[0]?.partnerId).toBe(longId);
  expect((await post(request, envelope({ referral_code: `${longCode}y` }))).status()).toBe(400);
});
