import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 2 (#538): cohort comparison is locked behind the premiumAnalytics
// setting (off by default — basic analytics stay free); once enabled, the API
// returns side-by-side metrics per cohort. Serial: it toggles a global Setting
// and restores it in finally.
test('cohort comparison is locked by default and returns metrics once enabled', async ({ page }) => {
  const stamp = `${Date.now()}`;
  const adminEmail = uniqueEmail('cohort-admin');
  const mentorEmail = uniqueEmail('cohort-mentor');
  const hiredEmail = uniqueEmail('cohort-hired');
  const activeEmail = uniqueEmail('cohort-active');
  const pw = 'CohortPass123';

  await seedUser(adminEmail, pw, 'ADMIN', 'Cohort Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Cohort Mentor');
  const hiredMentee = await seedUser(hiredEmail, 'x', 'MENTEE', 'Cohort Hired Mentee');
  const activeMentee = await seedUser(activeEmail, 'x', 'MENTEE', 'Cohort Active Mentee');

  const cohort = await prisma.cohort.create({ data: { name: `Compare Cohort ${stamp}`, term: '2026' } });
  const start = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const hiredRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: hiredMentee.id, cohortId: cohort.id, pipelineStatus: 'HIRED_660', startDate: start },
  });
  await prisma.statusChange.create({
    data: { relationId: hiredRel.id, fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: mentor.id, createdAt: new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000) },
  });
  const activeRel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: activeMentee.id, cohortId: cohort.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });
  await prisma.interactionLog.create({ data: { relationId: activeRel.id, type: 'Meeting', notes: 'sync', date: new Date() } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Locked by default (setting off) — basic analytics stay reachable.
    const locked = await page.request.get('/api/admin/analytics/cohorts');
    expect(locked.status()).toBe(403);
    expect((await page.request.get('/api/admin/analytics')).ok()).toBeTruthy();

    // Enable the premium tier via settings.
    const enable = await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } });
    expect(enable.ok()).toBeTruthy();

    const res = await page.request.get('/api/admin/analytics/cohorts');
    expect(res.ok()).toBeTruthy();
    const rows = (await res.json()).cohorts as {
      id: string; total: number; hired: number; inProgress: number;
      conversionToHired: number; avgDaysToHired: number | null;
    }[];
    const mine = rows.find((r) => r.id === cohort.id);
    expect(mine).toBeTruthy();
    expect(mine!.total).toBe(2);
    expect(mine!.hired).toBe(1);
    expect(mine!.inProgress).toBe(1);
    expect(mine!.conversionToHired).toBe(50);
    expect(mine!.avgDaysToHired).toBe(30);
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { cohortId: cohort.id } });
    await prisma.cohort.delete({ where: { id: cohort.id } }).catch(() => {});
    await cleanupByEmail(hiredEmail);
    await cleanupByEmail(activeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
