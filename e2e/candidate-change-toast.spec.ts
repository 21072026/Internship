import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #23: changing a field on the candidate detail page (stage/project/…) saved
// silently. It must now confirm with a toast.
test('changing a candidate\'s stage shows a confirmation toast', async ({ page }) => {
  const mentorEmail = uniqueEmail('toast-mentor');
  const menteeEmail = uniqueEmail('toast-mentee');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Toast Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Toast Mentee');
  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'APPLICATION_100' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    // The stage dropdown is the first <select> in the mentorship card.
    await page.locator('select').first().selectOption('INTERVIEW_PENDING_250');

    // A success toast confirms the save.
    await expect(page.getByRole('status').filter({ hasText: /saved|kaydedildi|gespeichert/i })).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
