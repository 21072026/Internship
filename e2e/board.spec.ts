import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor board groups a mentee under its pipeline stage', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const menteeEmail = uniqueEmail('mentee');
  const password = 'BoardPass123!';
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Board Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Board Mentee');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // Navigate via the sidebar "Pano" link
    await page.getByRole('link', { name: /pano/i }).click();
    await page.waitForURL((u) => u.pathname.includes('/mentor/board'), { timeout: 15_000 });

    // The mentee card sits inside the "450 · Staj devam ediyor" column
    const column = page.locator('div.w-64', { hasText: '450 · Staj devam ediyor' });
    await expect(column.getByText('Board Mentee')).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
