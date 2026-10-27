import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, userInWorld } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #1722 — the stage-SLA escalation ladder, end to end: a breach is opened
// (mentor told once), climbs to the org's administrators once
// `escalateAfterDays` have passed (once), stops at an acknowledgement, and a
// stage move resolves it. Plus the deploy-time mapping: a deadline the old
// one-shot reminder already covered is adopted silently.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;
const STAGE = 'APPROVAL_PENDING_220';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string, orgId: string | null, overdueDays: number, reminded: Date | null = null) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Ladder Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', `Ladder Mentee ${prefix}`);
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId } });
  const relation = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      orgId,
      status: 'ACTIVE',
      pipelineStatus: STAGE,
      stageDeadline: new Date(Date.now() - overdueDays * DAY),
      deadlineReminderSentAt: reminded,
    },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

test('a breach climbs mentor → administrators once each, and a stage move resolves it', async ({ page }) => {
  test.slow();
  const admin = await userInWorld(ADMIN_EMAIL, 'INTERNSHIP', { id: true, orgId: true });
  expect(admin?.orgId).toBeTruthy();
  const orgId = admin!.orgId!;
  const prior = await prisma.stageSla.findUnique({ where: { orgId_stageKey_scope: { orgId, stageKey: STAGE, scope: 'org' } } });
  // 5 days to wait, administrators told 3 days after a breach.
  await prisma.stageSla.upsert({
    where: { orgId_stageKey_scope: { orgId, stageKey: STAGE, scope: 'org' } },
    update: { days: 5, escalateAfterDays: 3 },
    create: { orgId, stageKey: STAGE, days: 5, escalateAfterDays: 3 },
  });
  // Overdue by one day: the mentor rung only.
  const pair = await seedPair('ladder', orgId, 1);
  const since = new Date(Date.now() - 1000);
  const bells = (userId: string, type: string) =>
    prisma.notification.count({ where: { userId, type, createdAt: { gte: since } } });

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const run = async () => {
      const res = await page.request.get('/api/cron?job=stage-deadlines');
      expect(res.ok()).toBeTruthy();
    };

    await run();
    const breach = await prisma.slaBreach.findFirstOrThrow({ where: { relationId: pair.relation.id } });
    expect(breach.level).toBe(1);
    expect(breach.orgId).toBe(orgId);
    expect(await bells(pair.mentor.id, 'deadline.stagePassed')).toBe(1);
    expect(await bells(admin!.id, 'deadline.slaEscalated')).toBe(0);

    // Four days past the deadline: three have passed since the breach. The
    // breach is keyed by the deadline it breached, so both move together.
    const fourDaysAgo = new Date(Date.now() - 4 * DAY);
    await prisma.mentorshipRelation.update({ where: { id: pair.relation.id }, data: { stageDeadline: fourDaysAgo } });
    await prisma.slaBreach.update({ where: { id: breach.id }, data: { dueAt: fourDaysAgo } });

    await run();
    await run();
    const climbed = await prisma.slaBreach.findUniqueOrThrow({ where: { id: breach.id } });
    expect(climbed.level).toBe(2);
    expect(climbed.resolvedAt).toBeNull();
    // Each rung exactly once, however often the job runs.
    expect(await bells(admin!.id, 'deadline.slaEscalated')).toBe(1);
    expect(await bells(pair.mentor.id, 'deadline.stagePassed')).toBe(1);

    // The stage moves: the breach closes and the administrators hear it cleared.
    const moved = await page.request.put(`/api/mentorship/${pair.relation.id}`, {
      data: { pipelineStatus: 'INTERVIEW_PENDING_250' },
    });
    expect(moved.ok()).toBeTruthy();
    const closed = await prisma.slaBreach.findUniqueOrThrow({ where: { id: breach.id } });
    expect(closed.resolvedAt).not.toBeNull();
    expect(await bells(admin!.id, 'deadline.slaResolved')).toBe(1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: admin!.id, type: { startsWith: 'deadline.sla' }, createdAt: { gte: since } } });
    await prisma.notification.deleteMany({ where: { userId: pair.mentor.id } });
    await cleanupByEmail(pair.menteeEmail);
    await cleanupByEmail(pair.mentorEmail);
    if (prior) {
      await prisma.stageSla.update({ where: { id: prior.id }, data: { days: prior.days, escalateAfterDays: prior.escalateAfterDays } });
    } else {
      await prisma.stageSla.deleteMany({ where: { orgId, stageKey: STAGE } });
    }
  }
});

test('acknowledging stops the climb, is audited, and is scoped to the caller’s org', { tag: '@smoke' }, async ({ page }) => {
  test.slow();
  const admin = await userInWorld(ADMIN_EMAIL, 'INTERNSHIP', { id: true, orgId: true });
  const orgId = admin!.orgId!;
  const prior = await prisma.stageSla.findUnique({ where: { orgId_stageKey_scope: { orgId, stageKey: STAGE, scope: 'org' } } });
  await prisma.stageSla.upsert({
    where: { orgId_stageKey_scope: { orgId, stageKey: STAGE, scope: 'org' } },
    update: { days: 5, escalateAfterDays: 3 },
    create: { orgId, stageKey: STAGE, days: 5, escalateAfterDays: 3 },
  });
  // Already reminded by the pre-ladder one-shot: adopted at level 1, no re-send.
  const pair = await seedPair('ladder-ack', orgId, 10, new Date(Date.now() - 9 * DAY));
  const other = await prisma.organization.create({ data: { name: 'Ladder Other Org', slug: `ladder-other-${Date.now()}` } });
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    // Open the breach without letting it climb: acknowledge first.
    const breach = await prisma.slaBreach.create({
      data: { orgId, relationId: pair.relation.id, stageKey: STAGE, dueAt: (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: pair.relation.id } })).stageDeadline!, level: 1 },
    });
    const foreign = await prisma.slaBreach.create({
      data: { orgId: other.id, relationId: pair.relation.id, stageKey: STAGE, dueAt: new Date(Date.now() - 50 * DAY), level: 1 },
    });

    // Another tenant's breach is not found, whatever the id.
    const cross = await page.request.post(`/api/admin/sla/${foreign.id}/acknowledge`);
    expect(cross.status()).toBe(404);
    expect((await prisma.slaBreach.findUniqueOrThrow({ where: { id: foreign.id } })).acknowledgedAt).toBeNull();
    await prisma.slaBreach.delete({ where: { id: foreign.id } });

    const ack = await page.request.post(`/api/admin/sla/${breach.id}/acknowledge`);
    expect(ack.ok()).toBeTruthy();
    expect(await prisma.activityLog.count({ where: { action: 'sla.breach_acknowledged', targetId: breach.id } })).toBe(1);

    const res = await page.request.get('/api/cron?job=stage-deadlines');
    expect(res.ok()).toBeTruthy();
    const after = await prisma.slaBreach.findUniqueOrThrow({ where: { id: breach.id } });
    expect(after.level).toBe(1);
    expect(after.resolvedAt).toBeNull();
    expect(await prisma.notification.count({ where: { userId: pair.mentor.id, type: 'deadline.stagePassed' } })).toBe(0);

    // A snooze needs a reason and a date in range.
    const bad = await page.request.post(`/api/admin/sla/${breach.id}/snooze`, { data: { until: new Date(Date.now() - DAY).toISOString(), reason: 'x' } });
    expect(bad.status()).toBe(400);
    const snooze = await page.request.post(`/api/admin/sla/${breach.id}/snooze`, {
      data: { until: new Date(Date.now() + 3 * DAY).toISOString(), reason: 'Waiting on the company' },
    });
    expect(snooze.ok()).toBeTruthy();
    expect(await prisma.activityLog.count({ where: { action: 'sla.breach_snoozed', targetId: breach.id } })).toBe(1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: pair.mentor.id } });
    await cleanupByEmail(pair.menteeEmail);
    await cleanupByEmail(pair.mentorEmail);
    await prisma.organization.delete({ where: { id: other.id } }).catch(() => {});
    if (prior) {
      await prisma.stageSla.update({ where: { id: prior.id }, data: { days: prior.days, escalateAfterDays: prior.escalateAfterDays } });
    } else {
      await prisma.stageSla.deleteMany({ where: { orgId, stageKey: STAGE } });
    }
  }
});

test('a deadline the old reminder already covered is adopted, not re-sent', async ({ page }) => {
  test.slow();
  const admin = await userInWorld(ADMIN_EMAIL, 'INTERNSHIP', { id: true, orgId: true });
  const orgId = admin!.orgId!;
  const pair = await seedPair('ladder-adopt', orgId, 2, new Date(Date.now() - DAY));
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const res = await page.request.get('/api/cron?job=stage-deadlines');
    expect(res.ok()).toBeTruthy();
    const breach = await prisma.slaBreach.findFirstOrThrow({ where: { relationId: pair.relation.id } });
    expect(breach.level).toBe(1);
    expect(await prisma.notification.count({ where: { userId: pair.mentor.id, type: 'deadline.stagePassed' } })).toBe(0);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: pair.mentor.id } });
    await cleanupByEmail(pair.menteeEmail);
    await cleanupByEmail(pair.mentorEmail);
  }
});
