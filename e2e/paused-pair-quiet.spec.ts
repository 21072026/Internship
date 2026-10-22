import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { prisma, seedMenteeWithRelation, cleanupMenteeWithRelation } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { freshIp } from './helpers/rateLimit';

/**
 * A paused pair leaves every nudge, queue and the active-pair count — and keeps
 * everything else (#1772).
 *
 * The sweeps are run through `/api/cron?job=…` as the seeded admin; what is
 * asserted is what they WROTE for the paused pair (claims, stamps,
 * notifications), because that is what a mail would have been sent from. Then
 * the free core: the paused pair still messages, sets goals, logs interactions
 * and loads its portal. Finally the resume hands back the same number of days
 * on the stage clock, not a fresh window, and clears the dormancy episode.
 */

const PASSWORD = 'PausedPair123!';
const DAY = 24 * 60 * 60 * 1000;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

async function signedIn(email: string, password = PASSWORD): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  expect((await signInViaApi(ctx, email, password, { headers: freshIp('paused-pair') })).ok, `sign-in as ${email}`).toBe(true);
  return ctx;
}

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a paused pair gets no reminders, keeps its free core, and resumes with the same clock', async () => {
  test.slow();
  const seeded = await seedMenteeWithRelation('paused', PASSWORD);
  const contexts: APIRequestContext[] = [];
  try {
    // Five days left on the stage clock, a dormancy episode in progress, and a
    // stage (INTERNSHIP_IN_PROGRESS_450, from the seed) the weekly-report chase targets.
    await prisma.mentorshipRelation.update({
      where: { id: seeded.relationId },
      data: { stageDeadline: new Date(Date.now() + 5 * DAY), dormantSince: new Date(Date.now() - 20 * DAY) },
    });

    const mentor = await signedIn(seeded.mentorEmail);
    const mentee = await signedIn(seeded.menteeEmail);
    const admin = await signedIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    contexts.push(mentor, mentee, admin);
    const lifecycle = `/api/mentorship/${seeded.relationId}/lifecycle`;

    expect((await mentor.post(lifecycle, { data: { to: 'PAUSED' } })).status()).toBe(200);
    let row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.stageDeadline).toBeNull();
    expect(row.stageDeadlineRemainingDays).toBe(5);

    // An overdue deadline set behind the clock's back still must not remind.
    await prisma.mentorshipRelation.update({
      where: { id: seeded.relationId },
      data: { stageDeadline: new Date(Date.now() - 2 * DAY), deadlineReminderSentAt: null },
    });
    for (const job of ['stage-deadlines', 'weekly-reports', 'dormant']) {
      expect((await admin.get(`/api/cron?job=${job}`)).ok(), job).toBe(true);
    }
    row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.deadlineReminderSentAt).toBeNull();
    expect(row.dormantNudgeCount).toBe(0);
    expect(await prisma.weeklyReportReminder.count({ where: { relationId: seeded.relationId } })).toBe(0);
    expect(
      await prisma.notification.count({
        where: { userId: { in: [seeded.mentorId, seeded.menteeId] }, NOT: { type: { startsWith: 'relation.lifecycle_' } } },
      })
    ).toBe(0);

    // The free core is untouched: a pause is an operational state, never a gate.
    expect((await mentor.post('/api/goals', { data: { relationId: seeded.relationId, title: 'Paused-pair goal' } })).ok()).toBe(true);
    expect((await mentor.post('/api/messages', { data: { relationId: seeded.relationId, body: 'Still here during the pause' } })).ok()).toBe(true);
    expect(
      (await mentor.post('/api/interactions', {
        data: { relationId: seeded.relationId, date: new Date().toISOString(), notes: 'Quick hello', type: 'Email' },
      })).ok()
    ).toBe(true);
    expect((await mentee.get('/portal')).status()).toBe(200);
    expect((await mentee.get(`/api/messages?relationId=${seeded.relationId}`)).ok()).toBe(true);

    // Resume: undo the test's own overdue write first, so the clock restore is what is measured.
    await prisma.mentorshipRelation.update({ where: { id: seeded.relationId }, data: { stageDeadline: null } });
    expect((await mentor.post(lifecycle, { data: { to: 'ACTIVE' } })).status()).toBe(200);
    row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.stageDeadlineRemainingDays).toBeNull();
    const daysLeft = (row.stageDeadline!.getTime() - Date.now()) / DAY;
    expect(daysLeft).toBeGreaterThan(4.9);
    expect(daysLeft).toBeLessThanOrEqual(5);
    expect(row.dormantSince).toBeNull();
  } finally {
    for (const ctx of contexts) await ctx.dispose();
    await prisma.notification.deleteMany({ where: { userId: { in: [seeded.mentorId, seeded.menteeId] } } });
    await cleanupMenteeWithRelation(seeded);
  }
});
