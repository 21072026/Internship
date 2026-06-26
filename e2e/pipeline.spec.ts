import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentor can change a mentee pipeline stage and it persists', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  const menteeEmail = uniqueEmail('mentee');
  const password = 'StagePass123!';
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Stage Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Stage Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    // New mentorships start at the first stage
    expect(relation.pipelineStatus).toBe('APPLICATION_100');

    // Sign in as the mentor
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // Open the mentee detail page and move the stage forward
    await page.goto(`/mentor/mentees/${relation.id}`);
    await expect(page.getByLabel('Pipeline aşaması')).toBeVisible();
    await page.getByLabel('Pipeline aşaması').selectOption('INTERNSHIP_IN_PROGRESS_450');
    await page.waitForTimeout(1800);

    // Persisted in the DB
    const updated = await prisma.mentorshipRelation.findUnique({ where: { id: relation.id } });
    expect(updated?.pipelineStatus).toBe('INTERNSHIP_IN_PROGRESS_450');

    // And reflected after reload
    await page.reload();
    await expect(page.getByLabel('Pipeline aşaması')).toHaveValue('INTERNSHIP_IN_PROGRESS_450');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
