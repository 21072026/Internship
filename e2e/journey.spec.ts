import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee portal shows a journey tracker reflecting the pipeline stage', async ({ page }) => {
  const mentorEmail = uniqueEmail('jt-mentor');
  const menteeEmail = uniqueEmail('jt-mentee');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'JT Mentor');
  const mentee = await seedUser(menteeEmail, 'MenteePass123', 'MENTEE', 'JT Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_IN_PROGRESS_450' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', menteeEmail);
    await page.fill('input[type="password"]', 'MenteePass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/portal');
    // The journey card renders the current stage label.
    await expect(page.getByText(/My journey/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Internship in progress/i).first()).toBeVisible();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
