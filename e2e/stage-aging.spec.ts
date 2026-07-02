import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

// EPIC G (#420): time-in-stage must be computed from real StatusChange
// transitions and show meaningful per-stage differences — not one uniform
// number for every stage.
test('stage aging reflects real per-stage durations from transitions', async ({ page }) => {
  const mentorEmail = uniqueEmail('sa-mentor');
  const menteeEmail = uniqueEmail('sa-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'SA Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'SA Mentee');
  const now = Date.now();
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'ACTIVE',
      pipelineStatus: 'INTERVIEW_PENDING_250',
      startDate: new Date(now - 10 * DAY),
    },
  });
  // APPLICATION_100 held for ~2 days (start → first change);
  // APPROVAL_PENDING_220 held for ~5 days (first → second change).
  await prisma.statusChange.createMany({
    data: [
      { relationId: rel.id, fromStatus: 'APPLICATION_100', toStatus: 'APPROVAL_PENDING_220', changedById: mentor.id, createdAt: new Date(now - 8 * DAY) },
      { relationId: rel.id, fromStatus: 'APPROVAL_PENDING_220', toStatus: 'INTERVIEW_PENDING_250', changedById: mentor.id, createdAt: new Date(now - 3 * DAY) },
    ],
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const data = await (await page.request.get('/api/admin/analytics/aging')).json();
    const byStage: Record<string, { avgDays: number }> = Object.fromEntries(
      data.stageAging.map((s: { pipelineStatus: string; avgDays: number }) => [s.pipelineStatus, s])
    );

    // Both completed stages are present with the durations we seeded…
    expect(byStage['APPLICATION_100']).toBeTruthy();
    expect(byStage['APPROVAL_PENDING_220']).toBeTruthy();
    // …and they differ (5 days vs 2 days) — not one uniform value.
    expect(byStage['APPROVAL_PENDING_220'].avgDays).toBeGreaterThan(byStage['APPLICATION_100'].avgDays);
  } finally {
    await prisma.statusChange.deleteMany({ where: { relationId: rel.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
