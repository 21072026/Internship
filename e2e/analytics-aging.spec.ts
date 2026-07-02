import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('hiring funnel aging: overdue and stuck candidates are surfaced', async ({ page }) => {
  const adminEmail = uniqueEmail('aging-admin');
  const mentorEmail = uniqueEmail('aging-mentor');
  const menteeEmail = uniqueEmail('aging-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Aging Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Aging Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Stuck Candidate');

  // Active, overdue stage deadline, backdated startDate → clearly "stuck".
  const rel = await prisma.mentorshipRelation.create({
    data: {
      mentorId: mentor.id,
      menteeId: mentee.id,
      status: 'ACTIVE',
      pipelineStatus: 'INTERVIEW_PENDING_250',
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      stageDeadline: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const data = await (await page.request.get('/api/admin/analytics/aging')).json();
    expect(data.overdueCount).toBeGreaterThanOrEqual(1);
    const stuck = data.oldestStuck.find((it: { relationId: string }) => it.relationId === rel.id);
    expect(stuck).toBeTruthy();
    expect(stuck.daysInStage).toBeGreaterThanOrEqual(29);
    expect(stuck.overdue).toBe(true);

    await page.goto('/admin/analytics');
    await expect(page.getByText(/Time in stage|Aşamada geçen süre/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: /Stuck Candidate/ })).toBeVisible();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
