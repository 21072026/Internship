import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// The account-event ingest from a registered machine source, end to end
// (#2450, #2451, #2452; one generic route since #2914 —
// docs/integrations/account-events.md).
//
// THE DOOR (tagged @smoke — a security boundary):
//   • no key is a 401 for EVERY slug, registered or not, so slugs cannot be
//     enumerated from outside;
//   • a key without `companies:write` is a 403 before the slug is looked at;
//   • an unregistered, malformed, disabled or another org's slug is one and the
//     same 404 `unknown_source`;
//   • a source bound to one key refuses every other key of the org (403
//     `wrong_source_key`) and lets its own key through.
//
// THE WRITER — the two critical claims of #2452 first:
//   1. the same event posted TWICE (in any letter case) writes one Company, one
//      funnel record and at most one StatusChange; trialEndsAt and externalId
//      are written once;
//   2. an account whose record is at DEAL_WON is NOT moved back by an event
//      naming it — the refusal is logged, the stage is untouched.
// …and the rest: a bad payload is a readable 400, a new account lands in
// TRIAL_ACTIVE with the source's own trial dates, its Source and a NONE
// contact permission, an event with no contact names the account after the
// source's label; `converted` moves to DEAL_WON with a history row; a lost
// record gets a NEW chained journey instead of being reopened; an out-of-date
// event is stale; an org without a default owner answers 409 and the event is
// retryable.
//
// Every slug is random per run and every id is a synthetic opaque string.

const STAMP = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const SLUG = `e2e-feed-${STAMP}`;
const OTHER_ORG_SLUG = `e2e-other-${STAMP}`;
const DISABLED_SLUG = `e2e-off-${STAMP}`;
const BOUND_SLUG = `e2e-bound-${STAMP}`;
const UNKNOWN_SLUG = `e2e-none-${STAMP}`;
const SOURCE_LABEL = 'E2E Feed';
const KEY_PREFIX = `e2e-account-events-${STAMP}`;
const DAY = 24 * 60 * 60 * 1000;
const eventsUrl = (slug: string) => `/api/integrations/${slug}/events`;
const extId = () => `ext-${randomBytes(6).toString('hex')}`;
const evtId = () => `evt-${randomBytes(6).toString('hex')}`;

let orgId: string;
let ownerlessOrgId: string;
let ownerId: string;
let writeKey: string;
let readKey: string;
let boundKey: string;
let ownerlessKey: string;
const emails: string[] = [];

async function mintKey(org: string, scopes: string): Promise<{ raw: string; id: string }> {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  const row = await prisma.apiKey.create({
    data: { name: `${KEY_PREFIX}-${randomBytes(3).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId: org },
    select: { id: true },
  });
  return { raw, id: row.id };
}

async function marketingOrg(label: string) {
  const org = await prisma.organization.create({
    data: { name: `Account Events ${label} ${STAMP}`, slug: `account-events-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId: org.id })),
  });
  return org.id;
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    event_id: evtId(),
    schema_version: 1,
    event_type: 'account_created',
    occurred_at: new Date().toISOString(),
    external_id: extId(),
    trial_started_at: new Date(Date.now() - DAY).toISOString(),
    trial_ends_at: new Date(Date.now() + 59 * DAY).toISOString(),
    acquisition_source: 'youtube',
    referral_code: `AFF${STAMP}`,
    contact: { first_name: 'Ingo', last_name: 'Ingest', email: `ingo-${STAMP}@shop.example`, company_name: `Ingest Shop ${STAMP}` },
    ...over,
  };
}

const post = (request: APIRequestContext, body: unknown, key: string | null = writeKey, slug = SLUG) =>
  request.post(eventsUrl(slug), { headers: key ? { authorization: `Bearer ${key}` } : {}, data: body });

/** An account with a lead and an active funnel record at `stage`. */
async function seedAccount(stage: string, externalId: string) {
  const company = await prisma.company.create({ data: { orgId, name: `Seeded ${stage} ${STAMP}`, externalId } });
  const leadEmail = uniqueEmail(`ext-lead-${stage.toLowerCase()}`);
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
  const ownerEmail = uniqueEmail('ext-owner');
  emails.push(ownerEmail);
  ownerId = (await seedUser(ownerEmail, 'OwnerPass123!', 'MENTOR', 'Account Events Owner', orgId)).id;
  await prisma.setting.create({ data: { orgId, key: 'defaultLeadOwnerId', value: ownerId } });
  writeKey = (await mintKey(orgId, 'companies:write')).raw;
  readKey = (await mintKey(orgId, 'candidates:read')).raw;
  const bound = await mintKey(orgId, 'companies:write');
  boundKey = bound.raw;
  ownerlessKey = (await mintKey(ownerlessOrgId, 'companies:write')).raw;

  await prisma.integrationSource.createMany({
    data: [
      { orgId, slug: SLUG, label: SOURCE_LABEL },
      { orgId, slug: DISABLED_SLUG, label: 'Switched off', enabled: false },
      { orgId, slug: BOUND_SLUG, label: 'Bound', apiKeyId: bound.id },
      { orgId: ownerlessOrgId, slug: SLUG, label: SOURCE_LABEL },
      { orgId: ownerlessOrgId, slug: OTHER_ORG_SLUG, label: 'Another tenant' },
    ],
  });
});

test.afterAll(async () => {
  const orgIds = [orgId, ownerlessOrgId].filter(Boolean);
  await prisma.integrationEvent.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.integrationSource.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.statusChange.deleteMany({ where: { relation: { orgId: { in: orgIds } } } });
  await prisma.mentorshipRelation.updateMany({ where: { orgId: { in: orgIds } }, data: { previousRelationId: null } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.source.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

test('no key is a 401 for every slug — registered, another org\'s, unknown or malformed', { tag: '@smoke' }, async ({ request }) => {
  for (const slug of [SLUG, OTHER_ORG_SLUG, DISABLED_SLUG, UNKNOWN_SLUG, 'Not_A-Slug']) {
    const res = await post(request, envelope(), null, slug);
    expect(res.status(), slug).toBe(401);
  }
  const forged = await post(request, envelope(), `icrm_${randomBytes(24).toString('hex')}`, SLUG);
  expect(forged.status()).toBe(401);
  expect(await prisma.integrationEvent.count({ where: { orgId: { in: [orgId, ownerlessOrgId] } } })).toBe(0);
});

test('a key without companies:write is a 403 before the slug is looked at', { tag: '@smoke' }, async ({ request }) => {
  for (const slug of [SLUG, UNKNOWN_SLUG]) {
    expect((await post(request, envelope(), readKey, slug)).status(), slug).toBe(403);
  }
});

test('an unknown, malformed, disabled or another org\'s slug is one and the same 404', { tag: '@smoke' }, async ({ request }) => {
  for (const slug of [UNKNOWN_SLUG, OTHER_ORG_SLUG, DISABLED_SLUG, 'x', 'Not_A-Slug']) {
    const res = await post(request, envelope(), writeKey, slug);
    expect(res.status(), slug).toBe(404);
    expect((await res.json()).code, slug).toBe('unknown_source');
  }
  // The other org's own key reaches its own source (a bad body proves the
  // gates passed without writing anything).
  expect((await post(request, { schema_version: 1 }, ownerlessKey, OTHER_ORG_SLUG)).status()).toBe(400);
  expect(await prisma.integrationEvent.count({ where: { orgId: { in: [orgId, ownerlessOrgId] } } })).toBe(0);
});

test('a source bound to one key refuses every other key of the org', { tag: '@smoke' }, async ({ request }) => {
  const refused = await post(request, envelope(), writeKey, BOUND_SLUG);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('wrong_source_key');
  // Its own key passes the door, the source and the binding: the bad body is
  // what answers.
  expect((await post(request, { schema_version: 1 }, boundKey, BOUND_SLUG)).status()).toBe(400);
  // An unbound source accepts any companies:write key of the org.
  expect((await post(request, { schema_version: 1 }, boundKey, SLUG)).status()).toBe(400);
});

test('a bad payload is a readable 400', async ({ request }) => {
  const bad = await post(request, envelope({ external_id: '   ', schema_version: 2, event_type: 'renamed_type', event_id: 'has space' }));
  expect(bad.status()).toBe(400);
  const paths = (await bad.json()).issues.map((i: { path: string }) => i.path);
  expect(paths).toEqual(expect.arrayContaining(['external_id', 'schema_version', 'event_type', 'event_id']));
});

test('the same event twice: one account, one record, the trial written once (#2452 claim 1)', async ({ request }) => {
  const event = envelope();
  const first = await post(request, event);
  expect(first.status(), await first.text()).toBe(200);
  expect((await first.json()).outcome).toBe('applied');
  const second = await post(request, event);
  expect((await second.json()).outcome).toBe('duplicate');
  // Event ids are case-insensitive: the same id in capitals is the same event.
  const shouted = await post(request, { ...event, event_id: event.event_id.toUpperCase() });
  expect((await shouted.json()).outcome).toBe('duplicate');

  const accounts = await prisma.company.findMany({ where: { orgId, externalId: event.external_id } });
  expect(accounts).toHaveLength(1);
  const relations = await prisma.mentorshipRelation.findMany({ where: { companyId: accounts[0].id } });
  expect(relations).toHaveLength(1);
  expect(relations[0].pipelineStatus).toBe('TRIAL_ACTIVE');
  // The source's own window, not the CRM's default 30 days from now.
  expect(relations[0].trialEndsAt?.toISOString()).toBe(new Date(event.trial_ends_at as string).toISOString());
  expect(relations[0].mentorId).toBe(ownerId);

  // Its Source is the referral code, and the account gets the machine NONE permission only.
  const lead = await prisma.user.findUniqueOrThrow({ where: { id: relations[0].menteeId }, include: { source: true } });
  expect(lead.source?.name).toBe(`affiliate:AFF${STAMP}`);
  const permission = await prisma.contactPermission.findFirst({ where: { companyId: accounts[0].id, channel: 'EMAIL' } });
  expect(permission?.basis).toBe('NONE');

  // The claim is keyed on the source's slug.
  const claims = await prisma.integrationEvent.findMany({ where: { orgId, eventId: event.event_id } });
  expect(claims.map((c) => [c.provider, c.outcome])).toEqual([[SLUG, 'applied']]);

  // An EXISTING lead moved into the trial by the same event twice: one history row.
  const externalId = extId();
  const seeded = await seedAccount('LEAD_QUALIFIED', externalId);
  const moveEvent = envelope({ external_id: externalId, event_type: 'trial_started' });
  expect((await (await post(request, moveEvent)).json()).outcome).toBe('applied');
  expect((await (await post(request, moveEvent)).json()).outcome).toBe('duplicate');
  const history = await prisma.statusChange.findMany({ where: { relationId: seeded.relationId } });
  expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual(['LEAD_QUALIFIED>TRIAL_ACTIVE']);
  expect(history[0].changedById).toBeNull();
});

test('an event with no contact names the new account after the source; ids are matched lower-cased', async ({ request }) => {
  const externalId = `EXT-${randomBytes(6).toString('hex').toUpperCase()}`;
  const res = await post(request, envelope({ external_id: externalId, contact: null }));
  expect((await res.json()).outcome).toBe('applied');
  const account = await prisma.company.findFirstOrThrow({ where: { orgId, externalId: externalId.toLowerCase() } });
  expect(account.name).toBe(`${SOURCE_LABEL} ${externalId.toLowerCase()}`);
});

test('a won account is never moved back to the trial (#2452 claim 2)', async ({ request }) => {
  const externalId = extId();
  const { relationId } = await seedAccount('DEAL_WON', externalId);
  const res = await post(request, envelope({ external_id: externalId }));
  expect((await res.json()).outcome).toBe('refused_backward');
  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } });
  expect(relation.pipelineStatus).toBe('DEAL_WON');
  expect(relation.trialEndsAt).toBeNull();
  expect(await prisma.statusChange.count({ where: { relationId } })).toBe(0);
  const log = await prisma.activityLog.findFirst({ where: { action: 'integration.backward_refused', targetId: relationId } });
  expect(log?.detail).toContain(SLUG);
  expect(log?.detail).toContain('DEAL_WON → TRIAL_ACTIVE');
  expect(log?.orgId).toBe(orgId);
});

test('converted moves the trial to DEAL_WON; an older event after it is stale', async ({ request }) => {
  const externalId = extId();
  const { relationId } = await seedAccount('TRIAL_ACTIVE', externalId);
  const won = await post(request, envelope({ external_id: externalId, event_type: 'converted', occurred_at: new Date().toISOString() }));
  expect((await won.json()).outcome).toBe('applied');
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).pipelineStatus).toBe('DEAL_WON');

  const late = await post(request, envelope({ external_id: externalId, event_type: 'trial_started', occurred_at: new Date(Date.now() - 10 * DAY).toISOString() }));
  expect((await late.json()).outcome).toBe('stale');
});

test('a lost account starting a new trial gets a NEW journey; the lost record is not reopened', async ({ request }) => {
  const externalId = extId();
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

test('an event type with no funnel mapping is recorded and moves nothing', async ({ request }) => {
  const externalId = extId();
  const { relationId } = await seedAccount('TRIAL_ACTIVE', externalId);
  const res = await post(request, envelope({ external_id: externalId, event_type: 'deactivated' }));
  expect((await res.json()).outcome).toBe('recorded');
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).pipelineStatus).toBe('TRIAL_ACTIVE');
  const log = await prisma.activityLog.findFirst({ where: { action: 'integration.event', targetId: externalId } });
  expect(log?.detail).toContain(`${SLUG}: deactivated`);
});

test('an org without a default owner answers 409, and the event is retryable once one is set', async ({ request }) => {
  const event = envelope();
  const refused = await post(request, event, ownerlessKey);
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe('no_default_owner');
  expect(await prisma.company.count({ where: { orgId: ownerlessOrgId } })).toBe(0);

  const repEmail = uniqueEmail('ext-owner-b');
  emails.push(repEmail);
  const rep = await seedUser(repEmail, 'OwnerPass123!', 'MENTOR', 'Account Events Owner B', ownerlessOrgId);
  await prisma.setting.create({ data: { orgId: ownerlessOrgId, key: 'defaultLeadOwnerId', value: rep.id } });
  const retried = await post(request, event, ownerlessKey);
  expect((await retried.json()).outcome).toBe('applied');
});
