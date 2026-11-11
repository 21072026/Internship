import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

/**
 * Customer payments from the source system (#3355, docs/integrations/account-events.md
 * § payment_received): a `payment_received` account event goes to the ONE
 * affiliate payment writer (`source: 'API'`), so it produces the commission a
 * manual entry would. Through the real door only.
 *
 * Pinned: the payment and its commission are written once (a repeated
 * payment id is `duplicate`); a customer no partner brought in is `no_partner`;
 * another currency is a `conflict`; another org's customer is not found; a dry
 * run judges and writes nothing.
 *
 * SYNTHETIC ONLY: throwaway MARKETING orgs, invented codes and references.
 */

const STAMP = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const SLUG = `e2e-pay-${STAMP}`;
const KEY_PREFIX = `e2e-pay-${STAMP}`;
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
const CODE = `pay-partner-${STAMP}`;

let orgA = '';
let orgB = '';
let writeKey = '';
let partnerId = '';
const emails: string[] = [];

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Acme Sales Pay ${label} ${STAMP}`, slug: `pay-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

const rid = () => crypto.randomBytes(6).toString('hex');
function envelope(over: Record<string, unknown> = {}) {
  return {
    event_id: `evt-${rid()}`,
    schema_version: 1,
    event_type: 'account_created',
    occurred_at: new Date().toISOString(),
    external_id: `acct-${rid()}`,
    trial_started_at: new Date(Date.now() - DAY).toISOString(),
    trial_ends_at: new Date(Date.now() + 19 * DAY).toISOString(),
    contact: { first_name: 'Ada', last_name: 'Example', email: `ada-${rid()}@shop.example`, company_name: `Shop ${STAMP} ${rid()}` },
    ...over,
  };
}
const paymentEvent = (externalId: string, payment: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  envelope({ event_type: 'payment_received', external_id: externalId, contact: null, payment, ...over });
const post = (request: APIRequestContext, body: unknown) =>
  request.post(`/api/integrations/${SLUG}/events`, { headers: { authorization: `Bearer ${writeKey}` }, data: body });
const postBatch = (request: APIRequestContext, body: unknown) =>
  request.post(`/api/integrations/${SLUG}/events/batch`, { headers: { authorization: `Bearer ${writeKey}` }, data: body });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgA = await marketingOrg('a');
  orgB = await marketingOrg('b');
  const ownerEmail = uniqueEmail('pay-owner');
  emails.push(ownerEmail);
  const owner = await seedUser(ownerEmail, 'PayE2E123!', 'MENTOR', 'Lead Owner', { orgId: orgA });
  await prisma.setting.create({ data: { orgId: orgA, key: 'defaultLeadOwnerId', value: owner.id } });
  await prisma.affiliateProgramSettings.create({ data: { orgId: orgA, plan: PLAN, planVersion: 1, planEffectiveAt: new Date() } });
  partnerId = (await prisma.affiliatePartner.create({ data: { orgId: orgA, code: CODE, displayName: 'Pay Partner' } })).id;
  await prisma.integrationSource.create({ data: { orgId: orgA, slug: SLUG, label: 'Billing Feed' } });
  const raw = `icrm_${crypto.randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: { name: `${KEY_PREFIX}-w`, hashedKey: crypto.createHash('sha256').update(raw).digest('hex'), scopes: 'companies:write', orgId: orgA },
  });
  writeKey = raw;
});

test.afterAll(async () => {
  const orgIds = [orgA, orgB].filter(Boolean);
  if (orgIds.length) {
    const where = { orgId: { in: orgIds } };
    await prisma.affiliateCommission.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePayment.deleteMany({ where }).catch(() => {});
    await prisma.affiliateCustomer.deleteMany({ where }).catch(() => {});
    await prisma.affiliatePartner.deleteMany({ where }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where }).catch(() => {});
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

test('a payment from the feed is recorded once, through the same writer, with the plan\'s commission', { tag: '@smoke' }, async ({ request }) => {
  // The customer arrives through a referral link (#3354) …
  const ext = `acct-${rid()}`;
  expect((await (await post(request, envelope({ external_id: ext, referral_code: CODE }))).json()).outcome).toBe('applied');

  // … and pays: one payment (source API), one commission from the plan's first tier.
  const ref = `INV-${STAMP}-1`;
  const first = paymentEvent(ext, { id: ref, amount_minor: 9_900, currency: 'EUR' });
  const res = await post(request, first);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ outcome: 'applied' });
  const payment = await prisma.affiliatePayment.findFirstOrThrow({ where: { orgId: orgA, externalPaymentRef: ref } });
  expect(payment).toMatchObject({ amountMinor: 9_900, currency: 'EUR', source: 'API', enteredById: null });
  const commissions = await prisma.affiliateCommission.findMany({ where: { orgId: orgA } });
  expect(commissions.map((c) => [c.partnerId, c.amountMinor])).toEqual([[partnerId, 2_500]]);
  expect(await prisma.auditLog.count({ where: { orgId: orgA, action: 'affiliate.payment.record', targetId: payment.id } })).toBe(1);

  // The same event again, and the same payment id under a new event id: nothing new.
  expect((await (await post(request, first)).json()).outcome).toBe('duplicate');
  const again = await post(request, paymentEvent(ext, { id: ref, amount_minor: 9_900, currency: 'EUR' }));
  expect(await again.json()).toMatchObject({ outcome: 'duplicate' });
  expect(await prisma.affiliatePayment.count({ where: { orgId: orgA } })).toBe(1);
  expect(await prisma.affiliateCommission.count({ where: { orgId: orgA } })).toBe(1);
});

test('no partner, another currency, another org\'s customer and a dry run write nothing', { tag: '@smoke' }, async ({ request }) => {
  const before = await prisma.affiliatePayment.count({ where: { orgId: orgA } });

  // A customer nobody referred (the account exists, no partner brought it in).
  const plain = `acct-${rid()}`;
  expect((await (await post(request, envelope({ external_id: plain }))).json()).outcome).toBe('applied');
  expect(await (await post(request, paymentEvent(plain, { id: `INV-${rid()}`, amount_minor: 1_000, currency: 'EUR' }))).json()).toMatchObject({ outcome: 'no_partner' });

  // A linked customer paying in a currency the plan does not use.
  const linked = `acct-${rid()}`;
  await post(request, envelope({ external_id: linked, referral_code: CODE }));
  const usd = await (await post(request, paymentEvent(linked, { id: `INV-${rid()}`, amount_minor: 1_000, currency: 'USD' }))).json();
  expect(usd).toMatchObject({ outcome: 'conflict' });
  expect(usd.detail).toContain('currency_mismatch');

  // Another organisation's customer is not found from this key's organisation.
  const foreignPartner = await prisma.affiliatePartner.create({ data: { orgId: orgB, code: `foreign-${STAMP}`, displayName: 'Foreign Partner' } });
  const foreignRef = `acct-${rid()}`;
  await prisma.affiliateCustomer.create({ data: { orgId: orgB, partnerId: foreignPartner.id, externalRef: foreignRef } });
  expect(await (await post(request, paymentEvent(foreignRef, { id: `INV-${rid()}`, amount_minor: 1_000, currency: 'EUR' }))).json()).toMatchObject({ outcome: 'no_partner' });

  // A dry run judges the payment as the real run would — and keeps nothing.
  const dry = await postBatch(request, { dry_run: true, events: [paymentEvent(linked, { id: `INV-${rid()}`, amount_minor: 2_000, currency: 'EUR' })] });
  expect(dry.status()).toBe(200);
  expect((await dry.json()).results[0].outcome).toBe('applied');

  expect(await prisma.affiliatePayment.count({ where: { orgId: orgA } })).toBe(before);
  expect(await prisma.affiliatePayment.count({ where: { orgId: orgB } })).toBe(0);

  // A payment without its `payment` block is refused at the door.
  expect((await post(request, envelope({ event_type: 'payment_received', external_id: linked }))).status()).toBe(400);
});
