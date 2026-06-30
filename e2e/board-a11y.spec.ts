import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('board card has a keyboard-accessible stage select that moves the relation', async ({ page }) => {
  const adminEmail = uniqueEmail('ba-admin');
  const mentorEmail = uniqueEmail('ba-mentor');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'BA Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'BA Mentor');
  const mentee = await seedUser(uniqueEmail('ba-mentee'), 'x', 'MENTEE', 'BA Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/board');
    await expect(page.getByText('BA Mentee')).toBeVisible({ timeout: 10_000 });

    await page.getByLabel('Move to stage').selectOption('INTERVIEW_PENDING_250');

    await expect.poll(async () => {
      const r = await prisma.mentorshipRelation.findUnique({ where: { id: rel.id } });
      return r?.pipelineStatus;
    }, { timeout: 10_000 }).toBe('INTERVIEW_PENDING_250');
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(mentee.email);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
