import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_PASSWORD = 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin sees drop reason options for dropped candidates', async ({ page }) => {
  const adminEmail = uniqueEmail('drop-admin');
  const mentorEmail = uniqueEmail('drop-mentor');
  const menteeEmail = uniqueEmail('drop-mentee');

  await seedUser(adminEmail, ADMIN_PASSWORD, 'ADMIN', 'Drop Reason Admin');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'Drop Reason Mentor');
  const mentee = await seedUser(menteeEmail, 'Pass1234!', 'MENTEE', 'Drop Reason Mentee');

  await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, pipelineStatus: 'INTERNSHIP_DROPPED_460' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);

    const dropReason = page.getByLabel('Drop reason');
    await expect(dropReason).toBeVisible();
    await expect(dropReason).toContainText('Candidate withdrew');
    await expect(dropReason).toContainText('No response');
    await expect(dropReason).toContainText('Other');

    await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/mentorship/') && res.request().method() === 'PUT'),
      page.selectOption('select#drop-reason', 'NO_RESPONSE'),
    ]);

    await page.reload();
    await expect(page.locator('select#drop-reason')).toHaveValue('NO_RESPONSE');
  } finally {
    await cleanupByEmail(adminEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});
