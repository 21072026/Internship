import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi, MARKETING_HOST, asHost } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';
import { partnerCustomerStatusCounts } from '../src/lib/affiliateCustomerStatus';

/**
 * The affiliate customer's end and the status thresholds (#3542,
 * docs/affiliate-module.md "Customer status"). Through the real doors only.
 *
 * THE EVENT WRITE (@smoke — a tenant boundary): `cancelled` stamps
 * `AffiliateCustomer.endedAt` on the key's OWN org's customer only — another
 * org's customer with the same external id is untouched; a second cancel keeps
 * the first end; a dry-run `reactivated` writes nothing; a live one clears it.
 *
 * THE SETTINGS: `freeMonths` / `passiveAfterDays` are saved through their own
 * route, refused out of range, audited, and never bump the plan version.
 *
 * THE COUNTS: `partnerCustomerStatusCounts()` — the one query the portal and the
 * admin funnel read — sorts one partner's customers into the four statuses and
 * never counts another org's.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs, invented codes and ids.
 */

const STAMP = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const SLUG = `e2e-cstat-${STAMP}`;
const KEY_PREFIX = `e2e-cstat-${STAMP}`;
const PW = 'StatusE2E123!';
const host = asHost(MARKETING_HOST);
const DAY = 24 * 60 * 60 * 1000;
const EXT = `acct-${crypto.randomBytes(6).toString('hex')}`;

let orgA = '';
let orgB = '';
let adminEmail = '';
let writeKey = '';
const contexts: APIRequestContext[] = [];

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Status ${label} ${STAMP}`, slug: `cstat-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

function envelope(eventType: string, occurredAt: Date) {
  return {
    event_id: `evt-${crypto.randomBytes(6).toString('hex')}`,
    schema_version: 1,
    event_type: eventType,
    occurred_at: occurredAt.toISOString(),
    external_id: EXT,
  };
}
const post = (request: APIRequestContext, body: unknown) =>
  request.post(`/api/integrations/${SLUG}/events`, { headers: { authorization: `Bearer ${writeKey}` }, data: body });
const postBatch = (request: APIRequestContext, body: unknown) =>
  request.post(`/api/integrations/${SLUG}/events/batch`, { headers: { authorization: `Bearer ${writeKey}` }, data: body });
const customerOf = (orgId: string) => prisma.affiliateCustomer.findFirstOrThrow({ where: { orgId, externalRef: EXT } });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgA = await marketingOrg('a');
  orgB = await marketingOrg('b');
  adminEmail = uniqueEmail('cstat-admin');
  await seedUser(adminEmail, PW, 'ADMIN', 'Programme Admin', { orgId: orgA });
  for (const orgId of [orgA, orgB]) {
    const partner = await prisma.affiliatePartner.create({ data: { orgId, code: `partner-${STAMP}`, displayName: 'Demo Partner' } });
    // The same external id in both orgs: references are unique per org only.
    await prisma.affiliateCustomer.create({ data: { orgId, partnerId: partner.id, externalRef: EXT, createdAt: new Date(Date.now() - 30 * DAY) } });
  }
  await prisma.integrationSource.create({ data: { orgId: orgA, slug: SLUG, label: 'Status Feed' } });
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
    await prisma.affiliatePayment.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where }).catch(() => {});
    await prisma.integrationEvent.deleteMany({ where }).catch(() => {});
    await prisma.integrationSource.deleteMany({ where }).catch(() => {});
    await prisma.activityLog.deleteMany({ where }).catch(() => {});
  }
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } }).catch(() => {});
  await cleanupByEmail(adminEmail);
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
  await prisma.$disconnect();
});

test('cancelled ends only the own org\'s customer; dry run writes nothing; reactivated clears it', { tag: '@smoke' }, async ({ request }) => {
  const cancelledAt = new Date(Date.now() - 2 * DAY);
  const first = await post(request, envelope('cancelled', cancelledAt));
  expect(first.status()).toBe(200);
  // The CRM has no account for the id: the funnel answer is unchanged, the end is kept.
  expect((await first.json()).outcome).toBe('unknown_account');
  expect((await customerOf(orgA)).endedAt?.toISOString()).toBe(cancelledAt.toISOString());
  expect((await customerOf(orgB)).endedAt).toBeNull();

  // A second cancellation keeps the first end.
  expect((await post(request, envelope('deactivated', new Date(Date.now() - DAY)))).status()).toBe(200);
  expect((await customerOf(orgA)).endedAt?.toISOString()).toBe(cancelledAt.toISOString());

  // A dry-run reactivation writes nothing.
  const dry = await postBatch(request, { dry_run: true, events: [envelope('reactivated', new Date())] });
  expect(dry.status()).toBe(200);
  expect((await dry.json()).dry_run).toBe(true);
  expect((await customerOf(orgA)).endedAt?.toISOString()).toBe(cancelledAt.toISOString());

  // A reactivation older than the end does not undo it.
  expect((await post(request, envelope('reactivated', new Date(cancelledAt.getTime() - DAY)))).status()).toBe(200);
  expect((await customerOf(orgA)).endedAt).not.toBeNull();

  // A live reactivation after the end clears it.
  expect((await post(request, envelope('reactivated', new Date()))).status()).toBe(200);
  expect((await customerOf(orgA)).endedAt).toBeNull();
  expect((await customerOf(orgB)).endedAt).toBeNull();
});

test('status thresholds are saved through their own route and never bump the plan version', async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL });
  contexts.push(admin);
  expect((await signInViaApi(admin, adminEmail, PW, { host: MARKETING_HOST })).ok).toBe(true);

  const read = async () => (await (await admin.get('/api/admin/affiliate/settings', { headers: host })).json()) as { planVersion: number; customerStatus: { freeMonths: number; passiveAfterDays: number } };
  const before = await read();
  expect(before.customerStatus).toEqual({ freeMonths: 2, passiveAfterDays: 45 });

  const put = (data: unknown) => admin.put('/api/admin/affiliate/settings/customer-status', { headers: host, data });
  const refused = await put({ freeMonths: -1, passiveAfterDays: 0 });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe('invalid_settings');

  const saved = await put({ freeMonths: 3, passiveAfterDays: 30 });
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toMatchObject({ ok: true, changed: true, settings: { freeMonths: 3, passiveAfterDays: 30 } });
  expect((await (await put({ freeMonths: 3, passiveAfterDays: 30 })).json()).changed).toBe(false);

  const after = await read();
  expect(after.customerStatus).toEqual({ freeMonths: 3, passiveAfterDays: 30 });
  expect(after.planVersion).toBe(before.planVersion);
  expect(await prisma.auditLog.count({ where: { orgId: orgA, action: 'affiliate.customer_status.update' } })).toBe(1);
});

test('the status counts sort a partner\'s customers by the rule, in its own org only', async () => {
  const org = await marketingOrg('c');
  const other = await marketingOrg('d');
  try {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const partner = await prisma.affiliatePartner.create({ data: { orgId: org, code: `count-${STAMP}`, displayName: 'Count Partner' } });
    const foreign = await prisma.affiliatePartner.create({ data: { orgId: other, code: `count-${STAMP}`, displayName: 'Foreign Partner' } });
    await prisma.affiliateProgramSettings.create({ data: { orgId: org, freeMonths: 2, passiveAfterDays: 45 } });
    const customer = async (orgId: string, partnerId: string, registeredDaysAgo: number, paidDaysAgo: number | null, endedDaysAgo: number | null = null) => {
      const c = await prisma.affiliateCustomer.create({
        data: { orgId, partnerId, externalRef: `c-${crypto.randomBytes(5).toString('hex')}`, createdAt: ago(registeredDaysAgo), endedAt: endedDaysAgo === null ? null : ago(endedDaysAgo) },
      });
      if (paidDaysAgo !== null) {
        await prisma.affiliatePayment.create({
          data: { orgId, customerId: c.id, amountMinor: 1_000, currency: 'EUR', receivedAt: ago(paidDaysAgo), externalPaymentRef: `pay-${crypto.randomBytes(5).toString('hex')}` },
        });
      }
    };
    await customer(org, partner.id, 10, null); // FREE_PERIOD
    await customer(org, partner.id, 100, null); // NEVER_PAID: the free period ran out
    await customer(org, partner.id, 10, null, 2); // NEVER_PAID: ended without paying
    await customer(org, partner.id, 100, 5); // ACTIVE
    await customer(org, partner.id, 200, 60); // PASSIVE: no payment for 60 days
    await customer(org, partner.id, 100, 5, 1); // PASSIVE: ended after paying
    await customer(other, foreign.id, 100, 5); // another org: never counted

    const counts = await partnerCustomerStatusCounts(org, { now });
    expect(Object.fromEntries(counts)).toEqual({ [partner.id]: { FREE_PERIOD: 1, NEVER_PAID: 2, ACTIVE: 1, PASSIVE: 2 } });
    // Narrowed to one partner; another org's partner id counts nothing.
    const narrowed = await partnerCustomerStatusCounts(org, { partnerIds: [partner.id, foreign.id], now });
    expect(narrowed.get(partner.id)).toEqual({ FREE_PERIOD: 1, NEVER_PAID: 2, ACTIVE: 1, PASSIVE: 2 });
    expect(narrowed.get(foreign.id)).toEqual({ FREE_PERIOD: 0, NEVER_PAID: 0, ACTIVE: 0, PASSIVE: 0 });
  } finally {
    const where = { orgId: { in: [org, other] } };
    await prisma.affiliatePayment.deleteMany({ where });
    await prisma.affiliateCustomer.deleteMany({ where });
    await prisma.affiliatePartner.deleteMany({ where });
    await prisma.affiliateProgramSettings.deleteMany({ where });
    await prisma.pipelineStage.deleteMany({ where });
    await prisma.organization.deleteMany({ where: { id: { in: [org, other] } } });
  }
});
