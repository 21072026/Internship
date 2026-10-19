import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { defaultTemplateForVertical, templateStagePayload } from '../src/lib/programTemplates';

// Historic mode of the account-event feed (docs/integrations/account-events.md
// § Historic mode): a replay of years of a source's history lands where it
// belongs in time, and SILENTLY.
//
//   • an event years old (no flag needed) creates the account, its lead and its
//     record dated at `occurred_at`; a trial that ran out lands at
//     TRIAL_EXPIRED with a history row dated at the trial's end; the closed
//     decision window is claimed up front; no trial reminder, no SLA deadline,
//     no notification, no queued mail; one aggregated activity line; and the
//     daily sweep run right after finds nothing to send, expire or ring;
//   • `replay: true` makes even a fresh event historic;
//   • a historic new journey dates the old record's end and the new one's start;
//   • a conversion inside the trial window takes the replay's own expiry back;
//   • a replayed move never lands underneath a person's newer move;
//   • a recent live event behaves exactly as before (no backdating, its own
//     activity lines, a running trial).

const STAMP = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const SLUG = `e2e-replay-${STAMP}`;
const KEY_PREFIX = `e2e-account-replay-${STAMP}`;
const DAY = 24 * 60 * 60 * 1000;
const PW = 'ReplayPass123!';
const extId = () => `ext-${randomBytes(6).toString('hex')}`;
const evtId = () => `evt-${randomBytes(6).toString('hex')}`;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);

let orgId: string;
let ownerId: string;
let writeKey: string;
const emails: string[] = [];
const startedAt = new Date();

function envelope(over: Record<string, unknown> = {}) {
  return {
    event_id: evtId(),
    schema_version: 1,
    event_type: 'account_created',
    occurred_at: new Date().toISOString(),
    external_id: extId(),
    contact: {
      first_name: 'Rita',
      last_name: 'Replay',
      email: `rita-${randomBytes(4).toString('hex')}-${STAMP}@acme-sales.example.test`,
      company_name: `Acme Sales ${randomBytes(3).toString('hex')} ${STAMP}`,
    },
    ...over,
  };
}

const post = (request: APIRequestContext, body: unknown) =>
  request.post(`/api/integrations/${SLUG}/events`, { headers: { authorization: `Bearer ${writeKey}` }, data: body });

/** Rows that would mean someone was told: bells, queued mail, reminder claims on the ladder. */
async function noiseFor(relationId: string) {
  return {
    ladderClaims: await prisma.trialReminder.count({ where: { relationId, threshold: { gte: 0 } } }),
    notifications: await prisma.notification.count({ where: { userId: ownerId } }),
    queuedMail: await prisma.job.count({ where: { name: 'email.send', orgId, createdAt: { gte: startedAt } } }),
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Account Replay ${STAMP}`, slug: `account-replay-${STAMP}`, vertical: 'MARKETING' },
  });
  orgId = org.id;
  await prisma.pipelineStage.createMany({
    data: templateStagePayload(defaultTemplateForVertical('MARKETING')!).stages.map((s) => ({ ...s, orgId })),
  });
  const ownerEmail = uniqueEmail('replay-owner');
  emails.push(ownerEmail);
  ownerId = (await seedUser(ownerEmail, PW, 'MENTOR', 'Replay Owner', orgId)).id;
  await prisma.setting.create({ data: { orgId, key: 'defaultLeadOwnerId', value: ownerId } });
  const raw = `icrm_${randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: { name: KEY_PREFIX, hashedKey: createHash('sha256').update(raw).digest('hex'), scopes: 'companies:write', orgId },
  });
  writeKey = raw;
  await prisma.integrationSource.create({ data: { orgId, slug: SLUG, label: 'E2E Replay' } });
});

test.afterAll(async () => {
  await prisma.integrationEvent.deleteMany({ where: { orgId } });
  await prisma.integrationSource.deleteMany({ where: { orgId } });
  await prisma.trialReminder.deleteMany({ where: { orgId } });
  await prisma.notification.deleteMany({ where: { userId: ownerId } });
  await prisma.statusChange.deleteMany({ where: { relation: { orgId } } });
  await prisma.mentorshipRelation.updateMany({ where: { orgId }, data: { previousRelationId: null } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.contactPermission.deleteMany({ where: { orgId } }).catch(() => {});
  const companyIds = (await prisma.company.findMany({ where: { orgId }, select: { id: true } })).map((c) => c.id);
  await prisma.activityLog.deleteMany({ where: { targetType: 'Company', targetId: { in: companyIds } } });
  await prisma.company.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  for (const e of emails) await cleanupByEmail(e).catch(() => {});
  await prisma.source.deleteMany({ where: { orgId } });
  await prisma.setting.deleteMany({ where: { orgId } });
  await prisma.apiKey.deleteMany({ where: { name: { startsWith: KEY_PREFIX } } });
  await prisma.activityLog.deleteMany({ where: { orgId } });
  await prisma.pipelineStage.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

test('a years-old trial lands at TRIAL_EXPIRED, dated in the past, and nobody is told', async ({ page, request }) => {
  test.setTimeout(150_000);
  const occurredAt = daysAgo(400);
  const trialEndsAt = daysAgo(370);
  const event = envelope({
    occurred_at: occurredAt.toISOString(),
    trial_started_at: occurredAt.toISOString(),
    trial_ends_at: trialEndsAt.toISOString(),
  });
  const res = await post(request, event);
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ outcome: 'applied', historic: true });

  const account = await prisma.company.findUniqueOrThrow({ where: { id: body.companyId } });
  expect(account.createdAt.toISOString()).toBe(occurredAt.toISOString());
  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: body.relationId } });
  expect(relation).toMatchObject({ pipelineStatus: 'TRIAL_EXPIRED', status: 'ACTIVE', stageDeadline: null });
  expect(relation.startDate.toISOString()).toBe(occurredAt.toISOString());
  expect(relation.trialEndsAt?.toISOString()).toBe(trialEndsAt.toISOString());
  const lead = await prisma.user.findUniqueOrThrow({ where: { id: relation.menteeId } });
  expect(lead.createdAt.toISOString()).toBe(occurredAt.toISOString());

  // The expiry happened when the trial ended, not today, and by the system.
  const history = await prisma.statusChange.findMany({ where: { relationId: relation.id } });
  expect(history.map((h) => [`${h.fromStatus}>${h.toStatus}`, h.createdAt.toISOString(), h.changedById])).toEqual([
    ['TRIAL_ACTIVE>TRIAL_EXPIRED', trialEndsAt.toISOString(), null],
  ]);

  // The decision window closed long ago: claimed up front, and nothing else.
  expect(await prisma.trialReminder.count({ where: { relationId: relation.id, threshold: -23 } })).toBe(1);
  expect(await noiseFor(relation.id)).toEqual({ ladderClaims: 0, notifications: 0, queuedMail: 0 });

  // One aggregated activity line for the request, none per event or account.
  const replayLines = await prisma.activityLog.findMany({ where: { orgId, action: 'integration.replay' } });
  expect(replayLines).toHaveLength(1);
  expect(replayLines[0].detail).toContain(`${SLUG}: 1 historic event(s)`);
  expect(replayLines[0].detail).toContain('trial_expired=1');
  expect(await prisma.activityLog.count({ where: { action: 'marketing.account.created', targetId: account.id } })).toBe(0);

  // The daily sweep, run right after, has nothing to send, expire or ring.
  const adminEmail = uniqueEmail('replay-admin');
  emails.push(adminEmail);
  await seedUser(adminEmail, PW, 'ADMIN', 'Replay Platform Admin');
  await signInAndSettle(page, adminEmail, PW, '/admin');
  const sweep = await page.request.get(`/api/cron?job=trial-reminders&orgId=${orgId}`);
  expect(sweep.status()).toBe(200);
  expect((await sweep.json()).trialReminders).toMatchObject({ sent: 0, expired: 0, decisionWindows: 0, failed: 0 });
  expect(await noiseFor(relation.id)).toEqual({ ladderClaims: 0, notifications: 0, queuedMail: 0 });

  // A later historic `converted` moves it on, dated at its own moment.
  const wonAt = daysAgo(350);
  const won = await post(request, envelope({ event_type: 'converted', external_id: event.external_id, occurred_at: wonAt.toISOString() }));
  expect(await won.json()).toMatchObject({ outcome: 'applied', historic: true, relationId: relation.id });
  const moved = await prisma.statusChange.findFirstOrThrow({ where: { relationId: relation.id, toStatus: 'DEAL_WON' } });
  expect(moved.createdAt.toISOString()).toBe(wonAt.toISOString());
  expect(await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).toMatchObject({
    pipelineStatus: 'DEAL_WON',
    stageDeadline: null,
  });
});

test('replay: true makes a fresh event historic; a trial still running stays running', async ({ request }) => {
  const occurredAt = daysAgo(1);
  const trialEndsAt = new Date(Date.now() + 20 * DAY);
  const res = await post(request, envelope({ replay: true, occurred_at: occurredAt.toISOString(), trial_ends_at: trialEndsAt.toISOString() }));
  const body = await res.json();
  expect(body).toMatchObject({ outcome: 'applied', historic: true });
  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: body.relationId } });
  expect(relation.pipelineStatus).toBe('TRIAL_ACTIVE');
  expect(relation.startDate.toISOString()).toBe(occurredAt.toISOString());
  expect(await prisma.statusChange.count({ where: { relationId: relation.id } })).toBe(0);
  expect(await prisma.trialReminder.count({ where: { relationId: relation.id } })).toBe(0);
});

test('a historic new journey dates the old record\'s end and the new record\'s start', async ({ request }) => {
  const externalId = extId();
  const company = await prisma.company.create({ data: { orgId, name: `Acme Sales Lost ${STAMP}`, externalId } });
  const leadEmail = uniqueEmail('replay-lost-lead');
  emails.push(leadEmail);
  const lead = await seedUser(leadEmail, PW, 'MENTEE', 'Lost Lead', orgId);
  const lost = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: lead.id, companyId: company.id, pipelineStatus: 'DEAL_LOST', startDate: daysAgo(700) },
  });
  const occurredAt = daysAgo(500);
  const res = await post(request, envelope({ event_type: 'trial_started', external_id: externalId, occurred_at: occurredAt.toISOString() }));
  const body = await res.json();
  expect(body).toMatchObject({ outcome: 'applied', historic: true });
  expect(body.relationId).not.toBe(lost.id);

  const old = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: lost.id } });
  expect(old.status).toBe('COMPLETED');
  expect(old.completedAt?.toISOString()).toBe(occurredAt.toISOString());
  const fresh = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: body.relationId } });
  expect(fresh.previousRelationId).toBe(lost.id);
  expect(fresh.startDate.toISOString()).toBe(occurredAt.toISOString());
  // The default 30-day window from the event ran out long ago.
  expect(fresh.pipelineStatus).toBe('TRIAL_EXPIRED');
  expect(await prisma.activityLog.count({ where: { orgId, action: 'integration.new_journey' } })).toBe(0);
});

test('a customer who paid during the trial never expired: the replay takes its own expiry back', async ({ request }) => {
  const occurredAt = daysAgo(400);
  const trialEndsAt = daysAgo(370);
  const created = await post(
    request,
    envelope({ occurred_at: occurredAt.toISOString(), trial_started_at: occurredAt.toISOString(), trial_ends_at: trialEndsAt.toISOString() }),
  );
  const body = await created.json();
  expect(body).toMatchObject({ outcome: 'applied', historic: true });
  const relationId = body.relationId as string;
  // On its own, the first event cannot know what comes next: it expires.
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).pipelineStatus).toBe('TRIAL_EXPIRED');

  const wonAt = daysAgo(390); // inside the trial window
  const externalId = (await prisma.company.findUniqueOrThrow({ where: { id: body.companyId } })).externalId;
  const won = await post(request, envelope({ event_type: 'converted', external_id: externalId, occurred_at: wonAt.toISOString() }));
  expect(await won.json()).toMatchObject({ outcome: 'applied', historic: true, relationId });

  const history = await prisma.statusChange.findMany({ where: { relationId }, orderBy: { createdAt: 'asc' } });
  expect(history.map((h) => [`${h.fromStatus}>${h.toStatus}`, h.createdAt.toISOString(), h.changedById])).toEqual([
    ['TRIAL_ACTIVE>DEAL_WON', wonAt.toISOString(), null],
  ]);
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relationId } })).pipelineStatus).toBe('DEAL_WON');
  expect(await noiseFor(relationId)).toEqual({ ladderClaims: 0, notifications: 0, queuedMail: 0 });
});

test('a replay never slides underneath a move a person made today', async ({ request }) => {
  const externalId = extId();
  const company = await prisma.company.create({ data: { orgId, name: `Acme Sales Worked ${STAMP}`, externalId } });
  const leadEmail = uniqueEmail('replay-worked-lead');
  emails.push(leadEmail);
  const lead = await seedUser(leadEmail, PW, 'MENTEE', 'Worked Lead', orgId);
  const record = await prisma.mentorshipRelation.create({
    data: { orgId, mentorId: ownerId, menteeId: lead.id, companyId: company.id, pipelineStatus: 'LEAD_QUALIFIED', startDate: daysAgo(30) },
  });
  const manualAt = new Date(Date.now() - 60_000);
  await prisma.statusChange.create({
    data: { relationId: record.id, fromStatus: 'LEAD_NEW', toStatus: 'LEAD_QUALIFIED', changedById: ownerId, createdAt: manualAt },
  });

  const res = await post(request, envelope({ event_type: 'trial_started', external_id: externalId, occurred_at: daysAgo(700).toISOString() }));
  expect(await res.json()).toMatchObject({ outcome: 'applied', historic: true, relationId: record.id });

  const history = await prisma.statusChange.findMany({ where: { relationId: record.id }, orderBy: { createdAt: 'asc' } });
  expect(history.map((h) => `${h.fromStatus}>${h.toStatus}`)).toEqual([
    'LEAD_NEW>LEAD_QUALIFIED',
    'LEAD_QUALIFIED>TRIAL_ACTIVE',
    'TRIAL_ACTIVE>TRIAL_EXPIRED',
  ]);
  // Strictly in order, and the person's move is no longer the newest: the
  // replayed moves land right after it, not two years underneath it.
  const times = history.map((h) => h.createdAt.getTime());
  expect(times[1]).toBeGreaterThan(times[0]);
  expect(times[2]).toBeGreaterThan(times[1]);
  expect(times[0]).toBe(manualAt.getTime());
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: record.id } })).pipelineStatus).toBe('TRIAL_EXPIRED');
});

test('a recent live event behaves exactly as before', async ({ request }) => {
  const before = Date.now();
  const replayLinesBefore = await prisma.activityLog.count({ where: { orgId, action: 'integration.replay' } });
  const event = envelope({
    trial_started_at: new Date(Date.now() - DAY).toISOString(),
    trial_ends_at: new Date(Date.now() + 19 * DAY).toISOString(),
  });
  const res = await post(request, event);
  const body = await res.json();
  expect(body.outcome).toBe('applied');
  expect(body.historic).toBeUndefined();
  const relation = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: body.relationId } });
  expect(relation.pipelineStatus).toBe('TRIAL_ACTIVE');
  expect(relation.startDate.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  const account = await prisma.company.findUniqueOrThrow({ where: { id: body.companyId } });
  expect(account.createdAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  // Its own activity line, as always — not folded into a replay line.
  // (That line carries no orgId today — pre-existing, matched on its target.)
  expect(await prisma.activityLog.count({ where: { action: 'marketing.account.created', targetId: body.companyId } })).toBe(1);
  expect(await prisma.activityLog.count({ where: { orgId, action: 'integration.replay' } })).toBe(replayLinesBefore);
  expect(await noiseFor(relation.id)).toEqual({ ladderClaims: 0, notifications: 0, queuedMail: 0 });
});
