import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { writeSetting } from '../src/lib/settingsWrite';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Loss, win-back, source fill and the batch endpoint of the account-event feed
// (#2966, docs/integrations/account-events.md § Event types, § Batch).
//
// THE BATCH DOOR (tagged @smoke — a security boundary): no key 401, a key
// without companies:write 403, another organization's source 404, more than
// 200 events 400 — and nothing written by any of them.
//
// THE WRITER:
//   • cancelled / deactivated → DEAL_LOST with CUSTOMER_CANCELLED once the
//     record had been won, else OTHER + "<slug>: ended during trial"; a live
//     loss is a real move (history row, activity line, SLA, the owner's bell);
//   • converted / reactivated on a lost record, and a new trial after an
//     expired one, open a NEW journey through the one win-back writer;
//   • a historic loss is written backdated and tells nobody;
//   • any event fills an unsourced lead's Source, and never overwrites one;
//   • a batch is processed in (external_id, occurred_at) order and answers in
//     the request's order; a dry run answers the same and writes nothing.
//
// Every slug is random per run and every id a synthetic opaque string.

const STAMP = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const SLUG = `e2e-lost-${STAMP}`;
const OTHER_SLUG = `e2e-lost-other-${STAMP}`;
const KEY_PREFIX = `e2e-account-lost-${STAMP}`;
const DAY = 24 * 60 * 60 * 1000;
const PW = 'LostPass123!';
const extId = () => `ext-${randomBytes(6).toString('hex')}`;
const evtId = () => `evt-${randomBytes(6).toString('hex')}`;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);

let orgId: string;
let otherOrgId: string;
let oldStagesOrgId: string;
let ownerId: string;
let writeKey: string;
let readKey: string;
const emails: string[] = [];
const startedAt = new Date();

async function mintKey(org: string, scopes: string): Promise<string> {
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: { name: `${KEY_PREFIX}-${randomBytes(3).toString('hex')}`, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes, orgId: org },
  });
  return raw;
}

async function marketingOrg(label: string, keep: (key: string) => boolean = () => true) {
  const org = await prisma.organization.create({
    data: { name: `Account Lost ${label} ${STAMP}`, slug: `account-lost-${label}-${STAMP}`, vertical: 'MARKETING' },
  });
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!)
      .stages.filter((s) => keep(s.key))
      .map((s) => ({ ...s, orgId: org.id })),
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
    contact: {
      first_name: 'Lena',
      last_name: 'Lost',
      email: `lena-${randomBytes(4).toString('hex')}-${STAMP}@acme-sales.example.test`,
      company_name: `Acme Sales ${randomBytes(3).toString('hex')} ${STAMP}`,
    },
    ...over,
  };
}

const post = (request: APIRequestContext, body: unknown, key: string | null = writeKey, slug = SLUG) =>
  request.post(`/api/integrations/${slug}/events`, { headers: key ? { authorization: `Bearer ${key}` } : {}, data: body });
const postBatch = (request: APIRequestContext, body: unknown, key: string | null = writeKey, slug = SLUG) =>
  request.post(`/api/integrations/${slug}/events/batch`, { headers: key ? { authorization: `Bearer ${key}` } : {}, data: body });

/** An account with a lead and an active funnel record at `stage`. */
async function seedAccount(stage: string, opts: { wonBefore?: boolean; trialEndsAt?: Date; sourced?: boolean } = {}) {
  const externalId = extId();
  const company = await prisma.company.create({ data: { orgId, name: `Acme Sales ${stage} ${randomBytes(3).toString('hex')} ${STAMP}`, externalId } });
  const leadEmail = uniqueEmail(`lost-lead-${stage.toLowerCase()}`);
  emails.push(leadEmail);
  const lead = await seedUser(leadEmail, PW, 'MENTEE', `Lead ${stage}`, orgId);
  if (opts.sourced) {
    const src = await prisma.source.create({ data: { orgId, name: `Fair ${STAMP}` } });
    await prisma.user.update({ where: { id: lead.id }, data: { sourceId: src.id } });
  }
  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId,
      mentorId: ownerId,
      menteeId: lead.id,
      companyId: company.id,
      pipelineStatus: stage,
      startDate: daysAgo(60),
      ...(opts.trialEndsAt ? { trialStartedAt: new Date(opts.trialEndsAt.getTime() - 30 * DAY), trialEndsAt: opts.trialEndsAt } : {}),
    },
  });
  if (opts.wonBefore) {
    await prisma.statusChange.create({
      data: { relationId: relation.id, fromStatus: 'TRIAL_ACTIVE', toStatus: 'DEAL_WON', changedById: ownerId, createdAt: daysAgo(40) },
    });
    if (stage === 'DEAL_LOST') {
      await prisma.statusChange.create({
        data: { relationId: relation.id, fromStatus: 'DEAL_WON', toStatus: 'DEAL_LOST', changedById: ownerId, reasonCode: 'PRICE', createdAt: daysAgo(20) },
      });
    }
  }
  return { externalId, companyId: company.id, relationId: relation.id, leadId: lead.id };
}

/** Rows that would mean someone was told. */
async function noiseFor(relationId: string) {
  return {
    notifications: await prisma.notification.count({ where: { userId: ownerId } }),
    stageChangeLines: await prisma.activityLog.count({ where: { action: 'pipeline.stage_change', targetId: relationId } }),
    queuedMail: await prisma.job.count({ where: { name: 'email.send', orgId, createdAt: { gte: startedAt } } }),
  };
}

/** Everything a dry run must leave untouched, counted for the org. */
async function footprint() {
  return {
    companies: await prisma.company.count({ where: { orgId } }),
    relations: await prisma.mentorshipRelation.count({ where: { orgId } }),
    history: await prisma.statusChange.count({ where: { relation: { orgId } } }),
    events: await prisma.integrationEvent.count({ where: { orgId } }),
    users: await prisma.user.count({ where: { orgId } }),
    sources: await prisma.source.count({ where: { orgId } }),
    permissions: await prisma.contactPermission.count({ where: { orgId } }),
    reminders: await prisma.trialReminder.count({ where: { orgId } }),
    activity: await prisma.activityLog.count({ where: { orgId } }),
    notifications: await prisma.notification.count({ where: { userId: ownerId } }),
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  orgId = await marketingOrg('a');
  otherOrgId = await marketingOrg('b');
  // A funnel not ready for a replay: no trial stages (an older stage set).
  oldStagesOrgId = await marketingOrg('c', (key) => !key.startsWith('TRIAL_'));
  const ownerEmail = uniqueEmail('lost-owner');
  emails.push(ownerEmail);
  ownerId = (await seedUser(ownerEmail, PW, 'MENTOR', 'Lost Owner', orgId)).id;
  await prisma.setting.create({ data: { orgId, key: 'defaultLeadOwnerId', value: ownerId } });
  // A service level on the lost stage: a live loss stamps a deadline, a historic one must not.
  await prisma.stageSla.create({ data: { orgId, stageKey: 'DEAL_LOST', days: 7 } });
  writeKey = await mintKey(orgId, 'companies:write');
  readKey = await mintKey(orgId, 'candidates:read');
  await prisma.integrationSource.createMany({
    data: [
      { orgId, slug: SLUG, label: 'E2E Lost' },
      { orgId: otherOrgId, slug: OTHER_SLUG, label: 'Another tenant' },
    ],
  });
});

test.afterAll(async () => {
  const orgIds = [orgId, otherOrgId, oldStagesOrgId].filter(Boolean);
  await prisma.integrationEvent.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.integrationSource.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.trialReminder.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.notification.deleteMany({ where: { userId: ownerId } });
  await prisma.statusChange.deleteMany({ where: { relation: { orgId: { in: orgIds } } } });
  await prisma.mentorshipRelation.updateMany({ where: { orgId: { in: orgIds } }, data: { previousRelationId: null } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.contactPermission.deleteMany({ where: { orgId: { in: orgIds } } }).catch(() => {});
  const companyIds = (await prisma.company.findMany({ where: { orgId: { in: orgIds } }, select: { id: true } })).map((c) => c.id);
  await prisma.activityLog.deleteMany({ where: { targetType: 'Company', targetId: { in: companyIds } } });
  await prisma.company.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
  for (const e of emails) await cleanupByEmail(e).catch(() => {});
  await prisma.source.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.stageSla.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.setting.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
  await prisma.activityLog.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.pipelineStage.deleteMany({ where: { orgId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.$disconnect();
});

// ── The batch door ───────────────────────────────────────────────────────────

test('batch: no key is a 401 for every slug', { tag: '@smoke' }, async ({ request }) => {
  for (const slug of [SLUG, OTHER_SLUG, `e2e-none-${STAMP}`]) {
    expect((await postBatch(request, { events: [envelope()] }, null, slug)).status(), slug).toBe(401);
  }
  expect((await postBatch(request, { events: [envelope()] }, `icrm_${randomBytes(24).toString('hex')}`)).status()).toBe(401);
  expect(await prisma.integrationEvent.count({ where: { orgId: { in: [orgId, otherOrgId] } } })).toBe(0);
});

test('batch: a key without companies:write is a 403', { tag: '@smoke' }, async ({ request }) => {
  const res = await postBatch(request, { events: [envelope()] }, readKey);
  expect(res.status()).toBe(403);
  expect(await prisma.integrationEvent.count({ where: { orgId } })).toBe(0);
});

test('batch: another organization\'s source is the same 404 as an unknown one', { tag: '@smoke' }, async ({ request }) => {
  for (const slug of [OTHER_SLUG, `e2e-none-${STAMP}`]) {
    const res = await postBatch(request, { events: [envelope()], dry_run: true }, writeKey, slug);
    expect(res.status(), slug).toBe(404);
    expect((await res.json()).code).toBe('unknown_source');
  }
  expect(await prisma.integrationEvent.count({ where: { orgId: { in: [orgId, otherOrgId] } } })).toBe(0);
});

test('batch: more than 200 events, or one invalid event, is a 400 and nothing is handled', { tag: '@smoke' }, async ({ request }) => {
  const tooMany = await postBatch(request, { events: Array.from({ length: 201 }, () => envelope()) });
  expect(tooMany.status()).toBe(400);
  expect((await tooMany.json()).code).toBe('too_many_events');

  const oneBad = await postBatch(request, { events: [envelope(), envelope({ external_id: '   ' }), envelope()] });
  expect(oneBad.status()).toBe(400);
  expect((await oneBad.json()).issues.map((i: { path: string }) => i.path)).toEqual(['events.1.external_id']);

  expect((await postBatch(request, { events: [] })).status()).toBe(400);
  expect((await postBatch(request, { events: [envelope()], dry_run: 'yes' })).status()).toBe(400);
  expect(await prisma.integrationEvent.count({ where: { orgId } })).toBe(0);
  expect(await prisma.company.count({ where: { orgId } })).toBe(0);
});

// ── Loss ─────────────────────────────────────────────────────────────────────

test('a live cancel during the trial moves to DEAL_LOST with OTHER and the fixed note — a real move', async ({ request }) => {
  const seeded = await seedAccount('TRIAL_ACTIVE', { trialEndsAt: new Date(Date.now() + 10 * DAY) });
  const before = await noiseFor(seeded.relationId);
  const res = await post(request, envelope({ event_type: 'cancelled', external_id: seeded.externalId }));
  expect(await res.json()).toMatchObject({ outcome: 'applied', relationId: seeded.relationId });

  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
  expect(relation).toMatchObject({ pipelineStatus: 'DEAL_LOST', status: 'ACTIVE' });
  const history = await prisma.statusChange.findMany({ where: { relationId: seeded.relationId } });
  expect(history.map((h) => [h.fromStatus, h.toStatus, h.reasonCode, h.reasonNote, h.changedById])).toEqual([
    ['TRIAL_ACTIVE', 'DEAL_LOST', 'OTHER', `${SLUG}: ended during trial`, null],
  ]);
  // The shared stage path ran: activity line, the stage's SLA, the owner's bell.
  expect(relation.stageDeadline).not.toBeNull();
  const after = await noiseFor(seeded.relationId);
  expect(after.stageChangeLines).toBe(before.stageChangeLines + 1);
  expect(after.notifications).toBeGreaterThan(before.notifications);
  // The lead itself is never mailed by it.
  expect(after.queuedMail).toBe(0);
});

test('a live deactivation of a won customer is CUSTOMER_CANCELLED', async ({ request }) => {
  const seeded = await seedAccount('DEAL_WON');
  const res = await post(request, envelope({ event_type: 'deactivated', external_id: seeded.externalId }));
  expect(await res.json()).toMatchObject({ outcome: 'applied', relationId: seeded.relationId });
  const row = await prisma.statusChange.findFirstOrThrow({ where: { relationId: seeded.relationId, toStatus: 'DEAL_LOST' } });
  expect([row.reasonCode, row.reasonNote]).toEqual(['CUSTOMER_CANCELLED', null]);

  // A second loss event for a record that already ended moves nothing.
  const again = await post(request, envelope({ event_type: 'cancelled', external_id: seeded.externalId }));
  expect(await again.json()).toMatchObject({ outcome: 'recorded' });
  expect(await prisma.statusChange.count({ where: { relationId: seeded.relationId } })).toBe(1);
});

test('a historic loss is backdated and tells nobody', async ({ request }) => {
  const seeded = await seedAccount('TRIAL_EXPIRED', { trialEndsAt: daysAgo(30) });
  // A deadline the record carried from the stage it leaves: the org manages
  // deadlines by SLA, so the historic move takes it away and sets none.
  await prisma.mentorshipRelation.update({ where: { id: seeded.relationId }, data: { stageDeadline: daysAgo(1) } });
  const lostAt = daysAgo(20);
  const before = await noiseFor(seeded.relationId);
  const res = await post(request, envelope({ event_type: 'cancelled', external_id: seeded.externalId, occurred_at: lostAt.toISOString() }));
  expect(await res.json()).toMatchObject({ outcome: 'applied', historic: true, relationId: seeded.relationId });

  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
  expect(relation).toMatchObject({ pipelineStatus: 'DEAL_LOST', stageDeadline: null, deadlineReminderSentAt: null });
  const row = await prisma.statusChange.findFirstOrThrow({ where: { relationId: seeded.relationId } });
  expect([row.toStatus, row.reasonCode, row.createdAt.toISOString()]).toEqual(['DEAL_LOST', 'OTHER', lostAt.toISOString()]);
  expect(await noiseFor(seeded.relationId)).toEqual(before);
});

// ── Win-back ─────────────────────────────────────────────────────────────────

test('converted on a lost record opens a chained DEAL_WON journey through win-back', async ({ request }) => {
  const seeded = await seedAccount('DEAL_LOST');
  const res = await post(request, envelope({ event_type: 'converted', external_id: seeded.externalId }));
  const body = await res.json();
  expect(body.outcome).toBe('applied');
  expect(body.relationId).not.toBe(seeded.relationId);

  const old = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
  expect(old).toMatchObject({ status: 'COMPLETED', pipelineStatus: 'DEAL_LOST', lifecycleState: 'ENDED_CHURNED' });
  const fresh = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: body.relationId } });
  expect(fresh).toMatchObject({
    status: 'ACTIVE',
    pipelineStatus: 'DEAL_WON',
    previousRelationId: seeded.relationId,
    menteeId: seeded.leadId,
    mentorId: ownerId,
    companyId: seeded.companyId,
  });
});

test('reactivated wins a lost customer back where they were; on a live record it moves nothing', async ({ request }) => {
  const paid = await seedAccount('DEAL_LOST', { wonBefore: true });
  const paidBack = await (await post(request, envelope({ event_type: 'reactivated', external_id: paid.externalId }))).json();
  expect(paidBack.outcome).toBe('applied');
  expect(await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: paidBack.relationId } })).toMatchObject({
    pipelineStatus: 'DEAL_WON',
    previousRelationId: paid.relationId,
  });

  const trialist = await seedAccount('DEAL_LOST');
  const trialBack = await (await post(request, envelope({ event_type: 'reactivated', external_id: trialist.externalId }))).json();
  const retrial = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: trialBack.relationId } });
  expect(retrial).toMatchObject({ pipelineStatus: 'TRIAL_ACTIVE', previousRelationId: trialist.relationId });
  expect(retrial.trialEndsAt).not.toBeNull();

  const live = await seedAccount('TRIAL_ACTIVE');
  const nothing = await (await post(request, envelope({ event_type: 'reactivated', external_id: live.externalId }))).json();
  expect(nothing).toMatchObject({ outcome: 'recorded', relationId: live.relationId });
  expect(await prisma.mentorshipRelation.count({ where: { companyId: live.companyId } })).toBe(1);
});

test('a new trial after an expired one is a re-trial through win-back', async ({ request }) => {
  const seeded = await seedAccount('TRIAL_EXPIRED', { trialEndsAt: daysAgo(2) });
  const body = await (await post(request, envelope({ event_type: 'trial_started', external_id: seeded.externalId }))).json();
  expect(body.outcome).toBe('applied');
  expect(body.relationId).not.toBe(seeded.relationId);
  expect(await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } })).toMatchObject({ status: 'COMPLETED' });
  expect(await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: body.relationId } })).toMatchObject({
    pipelineStatus: 'TRIAL_ACTIVE',
    previousRelationId: seeded.relationId,
  });
});

// ── Source fill ──────────────────────────────────────────────────────────────

test('any event fills an unsourced lead\'s Source and never overwrites one', async ({ request }) => {
  const unsourced = await seedAccount('TRIAL_ACTIVE');
  const code = `AFFLATE${STAMP}`;
  const res = await post(request, envelope({ event_type: 'plan_changed', external_id: unsourced.externalId, referral_code: code }));
  expect((await res.json()).outcome).toBe('recorded');
  const lead = await prisma.user.findUniqueOrThrow({ where: { id: unsourced.leadId }, include: { source: true } });
  expect(lead.source?.name).toBe(`affiliate:${code}`);
  expect(lead.source?.orgId).toBe(orgId);

  const sourced = await seedAccount('TRIAL_ACTIVE', { sourced: true });
  const kept = (await prisma.user.findUniqueOrThrow({ where: { id: sourced.leadId } })).sourceId;
  await post(request, envelope({ event_type: 'converted', external_id: sourced.externalId, acquisition_source: 'youtube' }));
  expect((await prisma.user.findUniqueOrThrow({ where: { id: sourced.leadId } })).sourceId).toBe(kept);
});

// ── The batch ────────────────────────────────────────────────────────────────

test('a batch is processed in (external_id, occurred_at) order and answers in the request\'s order', async ({ request }) => {
  const externalId = extId();
  const created = envelope({
    external_id: externalId,
    occurred_at: daysAgo(400).toISOString(),
    trial_started_at: daysAgo(400).toISOString(),
    trial_ends_at: daysAgo(370).toISOString(),
  });
  const won = envelope({ event_type: 'converted', external_id: externalId, occurred_at: daysAgo(390).toISOString(), contact: null });
  const lost = envelope({ event_type: 'cancelled', external_id: externalId, occurred_at: daysAgo(100).toISOString(), contact: null });
  // Listed newest first: in request order the conversion would find no account.
  const res = await postBatch(request, { events: [lost, won, created] });
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.dry_run).toBe(false);
  expect(body.results.map((r: { index: number; event_id: string; outcome: string; historic?: boolean }) => [r.index, r.event_id, r.outcome, r.historic])).toEqual([
    [0, lost.event_id, 'applied', true],
    [1, won.event_id, 'applied', true],
    [2, created.event_id, 'applied', true],
  ]);
  const relationId = body.results[2].relationId as string;
  const history = await prisma.statusChange.findMany({ where: { relationId }, orderBy: { createdAt: 'asc' } });
  // The conversion inside the trial took the replay's expiry back; the loss of a paying customer is CUSTOMER_CANCELLED.
  expect(history.map((h) => [`${h.fromStatus}>${h.toStatus}`, h.reasonCode, h.createdAt.toISOString()])).toEqual([
    ['TRIAL_ACTIVE>DEAL_WON', null, won.occurred_at],
    ['DEAL_WON>DEAL_LOST', 'CUSTOMER_CANCELLED', lost.occurred_at],
  ]);
  // One aggregated activity line for the whole batch.
  const replay = await prisma.activityLog.findMany({ where: { orgId, action: 'integration.replay', createdAt: { gte: startedAt } } });
  expect(replay.some((l) => (l.detail ?? '').includes(`${SLUG}: 3 historic event(s)`))).toBe(true);
});

test('per-event outcomes: unknown account, record-only, duplicate inside the batch', async ({ request }) => {
  const created = envelope({ occurred_at: daysAgo(10).toISOString() });
  const res = await postBatch(request, {
    events: [
      envelope({ event_type: 'converted', occurred_at: daysAgo(5).toISOString() }),
      envelope({ event_type: 'deleted', occurred_at: daysAgo(5).toISOString() }),
      created,
      created,
    ],
  });
  const outcomes = (await res.json()).results.map((r: { outcome: string }) => r.outcome);
  expect(outcomes).toEqual(['unknown_account', 'recorded', 'applied', 'duplicate']);
});

test('a batch for a funnel without the replay stages is a 409 and claims nothing', async ({ request }) => {
  const key = await mintKey(oldStagesOrgId, 'companies:write');
  const slug = `e2e-lost-old-${STAMP}`;
  await prisma.integrationSource.create({ data: { orgId: oldStagesOrgId, slug, label: 'Old stages' } });
  for (const dry_run of [false, true]) {
    const res = await postBatch(request, { events: [envelope({ occurred_at: daysAgo(30).toISOString() })], dry_run }, key, slug);
    expect(res.status(), await res.text()).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'missing_stages', stages: ['TRIAL_ACTIVE', 'TRIAL_EXPIRED'] });
  }
  expect(await prisma.integrationEvent.count({ where: { orgId: oldStagesOrgId } })).toBe(0);
  expect(await prisma.company.count({ where: { orgId: oldStagesOrgId } })).toBe(0);
});

test('an account waiting for the default owner holds back its later events; the resent batch replays it whole', async ({ request }) => {
  const externalId = extId();
  const created = envelope({ external_id: externalId, occurred_at: daysAgo(100).toISOString() });
  const won = envelope({ event_type: 'converted', external_id: externalId, occurred_at: daysAgo(90).toISOString(), contact: null });
  const lost = envelope({ event_type: 'cancelled', external_id: externalId, occurred_at: daysAgo(50).toISOString(), contact: null });
  const events = [lost, won, created];
  const ids = events.map((e) => e.event_id);

  await prisma.setting.deleteMany({ where: { orgId, key: 'defaultLeadOwnerId' } });
  try {
    const res = await postBatch(request, { events });
    expect(res.status(), await res.text()).toBe(200);
    const results = (await res.json()).results as { outcome: string; detail?: string }[];
    expect(results.map((r) => r.outcome)).toEqual(['no_default_owner', 'no_default_owner', 'no_default_owner']);
    // The account's first event decided it; the later two were never handled.
    expect(results[0].detail).toMatch(/^not handled:/);
    expect(results[1].detail).toMatch(/^not handled:/);
    expect(results[2].detail ?? '').not.toMatch(/^not handled:/);
    expect(await prisma.integrationEvent.count({ where: { orgId, eventId: { in: ids } } })).toBe(0);
    expect(await prisma.company.count({ where: { orgId, externalId } })).toBe(0);
  } finally {
    await writeSetting('defaultLeadOwnerId', ownerId, orgId);
  }

  const again = await (await postBatch(request, { events })).json();
  expect(again.results.map((r: { outcome: string }) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
  const company = await prisma.company.findFirstOrThrow({ where: { orgId, externalId } });
  const relation = await prisma.mentorshipRelation.findFirstOrThrow({ where: { companyId: company.id } });
  expect(relation.pipelineStatus).toBe('DEAL_LOST');
  const history = await prisma.statusChange.findMany({ where: { relationId: relation.id }, orderBy: { createdAt: 'asc' } });
  expect(history.map((h) => `${h.fromStatus}>${h.toStatus}:${h.reasonCode ?? ''}`)).toEqual([
    'TRIAL_ACTIVE>DEAL_WON:',
    'DEAL_WON>DEAL_LOST:CUSTOMER_CANCELLED',
  ]);
});

test('dry_run answers like the real run and writes nothing', async ({ request }) => {
  const already = envelope({ occurred_at: daysAgo(50).toISOString() });
  expect((await (await post(request, already)).json()).outcome).toBe('applied');

  const externalId = extId();
  const events = [
    envelope({ event_type: 'converted', external_id: externalId, occurred_at: daysAgo(300).toISOString(), contact: null }),
    envelope({ external_id: externalId, occurred_at: daysAgo(320).toISOString(), referral_code: `DRY${STAMP}` }),
    envelope({ event_type: 'cancelled', external_id: externalId, occurred_at: daysAgo(200).toISOString(), contact: null }),
    envelope({ event_type: 'reactivated', external_id: externalId, occurred_at: daysAgo(100).toISOString(), contact: null }),
    envelope({ event_type: 'converted', occurred_at: daysAgo(5).toISOString() }),
    already,
  ];
  const before = await footprint();
  const dry = await postBatch(request, { events, dry_run: true });
  expect(dry.status(), await dry.text()).toBe(200);
  const dryBody = await dry.json();
  expect(dryBody.dry_run).toBe(true);
  expect(await footprint()).toEqual(before);
  // No ids from rows the rollback removed.
  for (const r of dryBody.results) {
    expect(r.companyId).toBeUndefined();
    expect(r.relationId).toBeUndefined();
  }

  const real = await (await postBatch(request, { events })).json();
  const shape = (rs: { index: number; outcome: string; detail?: string }[]) => rs.map((r) => [r.index, r.outcome, r.detail ?? null]);
  expect(shape(dryBody.results)).toEqual(shape(real.results));
  expect(shape(real.results).map((r) => r[1])).toEqual(['applied', 'applied', 'applied', 'applied', 'unknown_account', 'duplicate']);
  // And the real run did write: a lost journey and its win-back.
  const company = await prisma.company.findFirstOrThrow({ where: { orgId, externalId } });
  const journeys = await prisma.mentorshipRelation.findMany({ where: { companyId: company.id }, orderBy: { startDate: 'asc' } });
  expect(journeys.map((j) => [j.status, j.pipelineStatus])).toEqual([
    ['COMPLETED', 'DEAL_LOST'],
    ['ACTIVE', 'DEAL_WON'],
  ]);
});

test('a win-back refused before it writes is a conflict that keeps a dry run going, as in the real run (#2988)', async ({ request }) => {
  // The lead already has another ACTIVE record (seeded straight into the table,
  // past the #419 helper, on purpose): winBack() refuses the `converted` on the
  // lost record BEFORE it closes anything. A dry run's writers join its one
  // transaction with no savepoint (src/lib/dbHandle.ts), so a refusal made after
  // the close would leave the record closed for the next event of the account —
  // or end the dry run as inconclusive.
  const lost = await seedAccount('DEAL_LOST', { wonBefore: true });
  const elsewhere = await prisma.company.create({ data: { orgId, name: `Acme Sales elsewhere ${randomBytes(3).toString('hex')} ${STAMP}` } });
  await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: lost.leadId, companyId: elsewhere.id, pipelineStatus: 'TRIAL_ACTIVE', startDate: daysAgo(10) },
  });
  const events = [
    envelope({ event_type: 'converted', external_id: lost.externalId, occurred_at: daysAgo(30).toISOString(), contact: null }),
    envelope({ event_type: 'cancelled', external_id: lost.externalId, occurred_at: daysAgo(20).toISOString(), contact: null }),
    envelope({ occurred_at: daysAgo(15).toISOString() }),
  ];

  const before = await footprint();
  const dry = await postBatch(request, { events, dry_run: true });
  expect(dry.status(), await dry.text()).toBe(200);
  const dryBody = await dry.json();
  expect(await footprint()).toEqual(before);

  const real = await (await postBatch(request, { events })).json();
  const shape = (rs: { index: number; outcome: string; detail?: string }[]) => rs.map((r) => [r.index, r.outcome, r.detail ?? null]);
  expect(shape(dryBody.results)).toEqual(shape(real.results));
  expect(real.results[0]).toMatchObject({ outcome: 'conflict', detail: 'the lead already has another active record' });
  expect(real.results[2].outcome).toBe('applied');
  // The refusal closed nothing.
  expect(await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: lost.relationId } })).toMatchObject({
    status: 'ACTIVE',
    pipelineStatus: 'DEAL_LOST',
  });
});
