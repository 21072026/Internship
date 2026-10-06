import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The SaleVali account-event ingest, end to end (#2450, #2451, #2452).
//
// WHAT THIS PROVES — the two critical claims of #2452 first:
//   1. the same event posted TWICE writes one Company, one funnel record and at
//      most one StatusChange; trialEndsAt and externalId are written once;
//   2. an account whose record is at DEAL_WON is NOT moved back by an event
//      naming it — the refusal is logged, the stage is untouched.
// …and the rest of #2450/#2451's acceptance: a key without `companies:write` is
// refused, a bad payload is a readable 400, a new account lands in TRIAL_ACTIVE
// with SaleVali's own trial dates, its Source and a NONE contact permission;
// `converted` moves to DEAL_WON with a history row; a lost record gets a NEW
// chained journey instead of being reopened; an out-of-date event is stale; an
// org without a default owner answers 409 and the event is retryable.
//
// NOT re-asserted: that a request with no key is refused (e2e/api-v1-key-
// enforcement.spec.ts owns the door's generic cases).

const STAMP = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const EVENTS = '/api/integrations/salevali/events';
const DAY = 24 * 60 * 60 * 1000;
const hex24 = () => randomBytes(12).toString('hex');

let orgId: string;
let ownerlessOrgId: string;
let ownerId: string;
let writeKey: string;
let readKey: string;
let ownerlessKey: string;
const emails: string[] = [];

async function mintKey(org: string, scopes: string): Promise<string> {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: { name: `e2e-sv-ingest-${STAMP}-${randomBytes(3).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId: org },
  });
  return raw;
}

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `SV Ingest ${label} ${STAMP}`, slug: `sv-ingest-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    event_id: hex24(),
    schema_version: 1,
    event_type: 'account_created',
    occurred_at: new Date().toISOString(),
    external_id: hex24(),
    license_type: 'affiliate_trial',
    status: 'first_login',
    trial_started_at: new Date(Date.now() - DAY).toISOString(),
    trial_ends_at: new Date(Date.now() + 59 * DAY).toISOString(),
    acquisition_source: 'youtube',
    reference: `AFF${STAMP}`,
    newsletter: true,
    contact: { name: 'Ingo', surname: 'Ingest', email: `ingo-${STAMP}@shop.example`, company_name: `Ingest Shop ${STAMP}` },
    ...over,
  };
}

const post = (request: APIRequestContext, body: unknown, key = writeKey) =>
  request.post(EVENTS, { headers: { authorization: `Bearer ${key}` }, data: body });

/** An account with a lead and an active funnel record at `stage`. */
async function seedAccount(stage: string, externalId: string) {
  const company = await prisma.company.create({ data: { orgId, name: `Seeded ${stage} ${STAMP}`, externalId } });
  const leadEmail = uniqueEmail(`sv-lead-${stage.toLowerCase()}`);
  emails.push(leadEmail);
  const lead = await seedUser(leadEmail, 'LeadPass123!', 'MENTEE', `Lead ${stage}`, orgId);
  const relation = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: lead.id, companyId: company.id, pipelineStatus: stage },
  });
  return { companyId: company.id, relationId: relation.id };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = await marketingOrg('a');
  ownerlessOrgId = await marketingOrg('b');
  const ownerEmail = uniqueEmail('sv-owner');
  emails.push(ownerEmail);
  ownerId = (await seedUser(ownerEmail, 'OwnerPass123!', 'MENTOR', 'SV Ingest Owner', orgId)).id;
  await prisma.setting.create({ data: { orgId, key: 'defaultLeadOwnerId', value: ownerId } });
  writeKey = await mintKey(orgId, 'companies:write');
  readKey = await mintKey(orgId, 'candidates:read');
  ownerlessKey = await mintKey(ownerlessOrgId, 'companies:write');
});

test.afterAll(async () => {
  const orgIds = [orgId, ownerlessOrgId].filter(Boolean);
  await prisma.integrationEvent.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.statusChange.deleteMany({ where: { relation: { orgId: { in: orgIds } } } });
  await prisma.mentorshipRelation.updateMany({ where: { orgId: { in: orgIds } }, data: { previousRelationId: null } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.source.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: `e2e-sv-ingest-${STAMP}` } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test('a key without companies:write is refused, and a bad payload is a readable 400', async ({ request }) => {
  expect((await post(request, envelope(), readKey)).status()).toBe(403);
  const bad = await post(request, envelope({ external_id: 'not-a-salevali-id', schema_version: 2 }));
  expect(bad.status()).toBe(400);
  const paths = (await bad.json()).issues.map((i: { path: string }) => i.path);
  expect(paths).toEqual(expect.arrayContaining(['external_id', 'schema_version']));
});

test('the same event twice: one account, one record, the trial written once (#2452 claim 1)', async ({ request }) => {
  const event = envelope();
  const first = await post(request, event);
  expect(first.status(), await first.text()).toBe(200);
  expect((await first.json()).outcome).toBe('applied');
  const second = await post(request, event);
  expect((await second.json()).outcome).toBe('duplicate');

  const accounts = await prisma.company.findMany({ where: { orgId, externalId: event.external_id } });
  expect(accounts).toHaveLength(1);
  const relations = await prisma.mentorshipRelation.findMany({ where: { companyId: accounts[0].id } });
  expect(relations).toHaveLength(1);
  expect(relations[0].pipelineStatus).toBe('TRIAL_ACTIVE');
  // SaleVali's own window, not the CRM's default 30 days from now.
  expect(relations[0].trialEndsAt?.toISOString()).toBe(new Date(event.trial_ends_at as string).toISOString());
  expect(relations[0].mentorId).toBe(ownerId);

  // Its Source is the affiliate, and the pre-ticked newsletter flag is NOT a permission.
  const lead = await prisma.user.findUniqueOrThrow({ where: { id: relations[0].menteeId }, include: { source: true } });
  expect(lead.source?.name).toBe(`affiliate:AFF${STAMP}`);
  const permission = await prisma.contactPermission.findFirst({ where: { companyId: accounts[0].id, channel: 'EMAIL' } });
  expect(permission?.basis).toBe('NONE');

  // An EXISTING lead moved into the trial by the same event twice: one history row.
  const externalId = hex24();
  const seeded = await seedAccount('LEAD_QUALIFIED', externalId);
  const moveEvent = envelope({ external_id: externalId, event_type: 'trial_started' });
  expect((await (await post(request, moveEvent)).json()).outcome).toBe('applied');
  expect((await (await post(request, moveEvent)).json()).outcome).toBe('duplicate');
  const history = await prisma.statusChange.findMany({ where: { relationId: seeded.relationId } });
  expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual(['LEAD_QUALIFIED>TRIAL_ACTIVE']);
  expect(history[0].changedById).toBeNull();
});

test('a won account is never moved back to the trial (#2452 claim 2)', async ({ request }) => {
  const externalId = hex24();
  const { relationId } = await seedAccount('DEAL_WON', externalId);
  const res = await post(request, envelope({ external_id: externalId }));
  expect((await res.json()).outcome).toBe('refused_backward');
  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(relation.pipelineStatus).toBe('DEAL_WON');
  expect(relation.trialEndsAt).toBeNull();
  expect(await prisma.statusChange.count({ where: { relationId } })).toBe(0);
  const log = await prisma.activityLog.findFirst({ where: { action: 'salevali.backward_refused', targetId: relationId } });
  expect(log?.detail).toContain('DEAL_WON → TRIAL_ACTIVE');
});

test('converted moves the trial to DEAL_WON; an older event after it is stale', async ({ request }) => {
  const externalId = hex24();
  const { relationId } = await seedAccount('TRIAL_ACTIVE', externalId);
  const won = await post(request, envelope({ external_id: externalId, event_type: 'converted', occurred_at: new Date().toISOString() }));
  expect((await won.json()).outcome).toBe('applied');
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).pipelineStatus).toBe('DEAL_WON');

  const late = await post(request, envelope({ external_id: externalId, event_type: 'trial_started', occurred_at: new Date(Date.now() - 10 * DAY).toISOString() }));
  expect((await late.json()).outcome).toBe('stale');
});

test('a lost merchant starting a new trial gets a NEW journey; the lost record is not reopened', async ({ request }) => {
  const externalId = hex24();
  const { companyId, relationId } = await seedAccount('DEAL_LOST', externalId);
  const res = await post(request, envelope({ external_id: externalId, event_type: 'trial_started' }));
  const body = await res.json();
  expect(body.outcome).toBe('applied');
  expect(body.relationId).not.toBe(relationId);

  const old = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(old.pipelineStatus).toBe('DEAL_LOST');
  expect(old.status).toBe('COMPLETED');
  const fresh = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: body.relationId } });
  expect(fresh).toMatchObject({ companyId, previousRelationId: relationId, pipelineStatus: 'TRIAL_ACTIVE', status: 'ACTIVE' });
});

test('an event with no funnel mapping yet is recorded and moves nothing', async ({ request }) => {
  const externalId = hex24();
  const { relationId } = await seedAccount('TRIAL_ACTIVE', externalId);
  const res = await post(request, envelope({ external_id: externalId, event_type: 'passivated' }));
  expect((await res.json()).outcome).toBe('recorded');
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).pipelineStatus).toBe('TRIAL_ACTIVE');
});

test('an org without a default owner answers 409, and the event is retryable once one is set', async ({ request }) => {
  const event = envelope();
  const refused = await post(request, event, ownerlessKey);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe('no_default_owner');
  expect(await prisma.company.count({ where: { orgId: ownerlessOrgId } })).toBe(0);

  const repEmail = uniqueEmail('sv-owner-b');
  emails.push(repEmail);
  const rep = await seedUser(repEmail, 'OwnerPass123!', 'MENTOR', 'SV Ingest Owner B', ownerlessOrgId);
  await prisma.setting.create({ data: { orgId: ownerlessOrgId, key: 'defaultLeadOwnerId', value: rep.id } });
  const retried = await post(request, event, ownerlessKey);
  expect((await retried.json()).outcome).toBe('applied');
});
