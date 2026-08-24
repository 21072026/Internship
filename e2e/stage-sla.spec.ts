import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #817 — per-stage service levels.
//
// The failure mode this guards against is silent: three endpoints move a
// pipelineStatus, and if one of them forgets the deadline the SLA report lies
// without anything looking broken. So all three are exercised, and the
// "configured nothing" case is pinned too — an existing installation must stay
// exactly as quiet as it was.

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string, orgId: string | null) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'SLA Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'SLA Mentee');
  await prisma.user.updateMany({ where: { id: { in: [mentor.id, mentee.id] } }, data: { orgId } });
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, orgId, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

test('every stage-moving endpoint applies the org’s service level', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  const a = await seedPair('sla-a', orgId);
  const b = await seedPair('sla-b', orgId);
  const c = await seedPair('sla-c', orgId);

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    // "Nobody waits more than 5 days at 220."
    const saved = await page.request.put('/api/admin/stage-sla', {
      data: { slas: [{ stageKey: 'APPROVAL_PENDING_220', days: 5 }] },
    });
    expect(saved.ok()).toBeTruthy();

    const within = (deadline: Date | null | undefined, days: number) => {
      expect(deadline).toBeTruthy();
      const expected = Date.now() + days * DAY;
      // Generous window: the assertion is "five days from now", not a clock test.
      expect(Math.abs(deadline!.getTime() - expected)).toBeLessThan(60 * 60 * 1000);
    };

    // 1 · The board / candidate page path.
    const put = await page.request.put(`/api/mentorship/${a.relation.id}`, {
      data: { pipelineStatus: 'APPROVAL_PENDING_220' },
    });
    expect(put.ok()).toBeTruthy();
    within((await prisma.mentorshipRelation.findUnique({ where: { id: a.relation.id } }))?.stageDeadline, 5);

    // 2 · The audit-trail path.
    const sc = await page.request.post('/api/status-changes', {
      data: { relationId: b.relation.id, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220' },
    });
    expect(sc.ok()).toBeTruthy();
    within((await prisma.mentorshipRelation.findUnique({ where: { id: b.relation.id } }))?.stageDeadline, 5);

    // 3 · Bulk advance.
    const bulk = await page.request.post('/api/admin/candidates/bulk', {
      data: { action: 'advanceStage', candidateIds: [c.mentee.id] },
    });
    expect(bulk.ok()).toBeTruthy();
    within((await prisma.mentorshipRelation.findUnique({ where: { id: c.relation.id } }))?.stageDeadline, 5);

    // Moving on to a stage with no rule STOPS the clock rather than leaving the
    // previous stage's date behind to report a meaningless overdue.
    await page.request.put(`/api/mentorship/${a.relation.id}`, {
      data: { pipelineStatus: 'INTERVIEW_PENDING_250' },
    });
    const afterUnruled = await prisma.mentorshipRelation.findUnique({ where: { id: a.relation.id } });
    expect(afterUnruled?.stageDeadline).toBeNull();

    // A date typed in by hand beats the rule.
    const manual = new Date(Date.now() + 30 * DAY);
    await page.request.put(`/api/mentorship/${b.relation.id}`, {
      data: { pipelineStatus: 'INTRODUCTION_PENDING_270', stageDeadline: manual.toISOString() },
    });
    const afterManual = await prisma.mentorshipRelation.findUnique({ where: { id: b.relation.id } });
    expect(Math.abs((afterManual?.stageDeadline?.getTime() ?? 0) - manual.getTime())).toBeLessThan(60 * 1000);
  } finally {
    await page.request.put('/api/admin/stage-sla', {
      data: { slas: [{ stageKey: 'APPROVAL_PENDING_220', days: null }] },
    }).catch(() => {});
    if (orgId) await prisma.stageSla.deleteMany({ where: { orgId } });
    for (const p of [a, b, c]) {
      await cleanupByEmail(p.menteeEmail);
      await cleanupByEmail(p.mentorEmail);
    }
  }
});

test('an organisation that configures no service level keeps its deadlines untouched', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  if (orgId) await prisma.stageSla.deleteMany({ where: { orgId } });
  const pair = await seedPair('sla-none', orgId);
  const manual = new Date(Date.now() + 14 * DAY);
  await prisma.mentorshipRelation.update({ where: { id: pair.relation.id }, data: { stageDeadline: manual } });

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    const res = await page.request.put(`/api/mentorship/${pair.relation.id}`, {
      data: { pipelineStatus: 'APPROVAL_PENDING_220' },
    });
    expect(res.ok()).toBeTruthy();

    // With no rules configured at all, the field is not SLA-managed: the date a
    // human typed survives the stage change exactly as it did before #817.
    const after = await prisma.mentorshipRelation.findUnique({ where: { id: pair.relation.id } });
    expect(Math.abs((after?.stageDeadline?.getTime() ?? 0) - manual.getTime())).toBeLessThan(60 * 1000);
  } finally {
    await cleanupByEmail(pair.menteeEmail);
    await cleanupByEmail(pair.mentorEmail);
  }
});

test('an admin sets a service level from settings and it comes back', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');
    await page.goto('/admin/settings');
    const input = page.getByTestId('sla-APPROVAL_PENDING_220');
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill('7');
    await page.getByTestId('stage-sla-save').click();

    await expect
      .poll(async () => {
        const got = await (await page.request.get('/api/admin/stage-sla')).json();
        return got.stages.find((s: { key: string }) => s.key === 'APPROVAL_PENDING_220')?.days ?? null;
      }, { timeout: 15_000 })
      .toBe(7);
    // Saving reloads the list, and that reload is what puts the saved value
    // back into the field. Waiting for the SERVER (above) is not the same as
    // waiting for the FORM: clearing the input while the reload is still in
    // flight gets undone the moment it lands.
    await expect(input).toHaveValue('7');

    // Removing a rule is asserted against the API rather than by emptying the
    // field: clearing a number input in a way React reliably observes is a
    // browser-quirk fight that would test the harness, not the product. The
    // contract that matters is that a null (or zero) removes the row instead of
    // storing "0 days", which would make everything instantly overdue.
    const cleared = await page.request.put('/api/admin/stage-sla', {
      data: { slas: [{ stageKey: 'APPROVAL_PENDING_220', days: null }] },
    });
    expect(cleared.ok()).toBeTruthy();
    const after = await (await page.request.get('/api/admin/stage-sla')).json();
    expect(after.stages.find((s: { key: string }) => s.key === 'APPROVAL_PENDING_220')?.days ?? null).toBeNull();

    const zeroed = await page.request.put('/api/admin/stage-sla', {
      data: { slas: [{ stageKey: 'APPROVAL_PENDING_220', days: 0 }] },
    });
    expect(zeroed.ok()).toBeTruthy();
    const afterZero = await (await page.request.get('/api/admin/stage-sla')).json();
    expect(afterZero.stages.find((s: { key: string }) => s.key === 'APPROVAL_PENDING_220')?.days ?? null).toBeNull();
    expect(await prisma.stageSla.count({ where: { orgId: orgId!, stageKey: 'APPROVAL_PENDING_220' } })).toBe(0);
  } finally {
    if (orgId) await prisma.stageSla.deleteMany({ where: { orgId } });
  }
});

test('the overdue reminder fires once per deadline, however often the job runs', async ({ page }) => {
  test.slow();
  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { orgId: true } });
  const orgId = admin?.orgId ?? null;
  const pair = await seedPair('sla-cron', orgId);
  // Already past its deadline, and never reminded about.
  await prisma.mentorshipRelation.update({
    where: { id: pair.relation.id },
    data: {
      pipelineStatus: 'APPROVAL_PENDING_220',
      stageDeadline: new Date(Date.now() - 2 * DAY),
      deadlineReminderSentAt: null,
    },
  });

  try {
    await signInAndSettle(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/admin');

    const first = await page.request.get('/api/cron?job=stage-deadlines');
    expect(first.ok()).toBeTruthy();
    const afterFirst = await prisma.mentorshipRelation.findUnique({ where: { id: pair.relation.id } });
    expect(afterFirst?.deadlineReminderSentAt).not.toBeNull();
    const notified = await prisma.notification.count({
      where: { userId: pair.mentor.id, type: 'deadline.stagePassed' },
    });
    expect(notified).toBe(1);

    // Run it again — nothing new. The guard is the stamp, so a cron that
    // double-fires (or an admin who re-runs it) cannot nag twice for the same
    // deadline.
    const second = await page.request.get('/api/cron?job=stage-deadlines');
    expect(second.ok()).toBeTruthy();
    const stillOne = await prisma.notification.count({
      where: { userId: pair.mentor.id, type: 'deadline.stagePassed' },
    });
    expect(stillOne).toBe(1);
  } finally {
    await prisma.notification.deleteMany({ where: { userId: pair.mentor.id } });
    await cleanupByEmail(pair.menteeEmail);
    await cleanupByEmail(pair.mentorEmail);
  }
});
