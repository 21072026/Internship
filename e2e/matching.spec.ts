import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('candidate detail shows a next-action hint once a mentor is assigned', async ({ page }) => {
  const adminEmail = uniqueEmail('matchadmin');
  const menteeEmail = uniqueEmail('matchmentee');
  const mentorEmail = uniqueEmail('matchmentor');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Match Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Match Mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Match Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByText('Next action:')).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
