import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a new application notifies the mentor in-app', async ({ page }) => {
  const mentorEmail = uniqueEmail('notementor');
  const applicantEmail = uniqueEmail('noteapplicant');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Note Mentor');

  try {
    // Anonymous public application → should create a notification for the mentor.
    const res = await page.request.post('/api/apply', {
      data: { mentorId: mentor.id, fullName: 'Note Applicant', email: applicantEmail },
    });
    expect(res.ok()).toBeTruthy();

    await expect
      .poll(async () => prisma.notification.count({ where: { userId: mentor.id } }), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // Mentor signs in and sees the notification.
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', mentorEmail);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    await page.getByLabel('Notifications').first().click();
    await expect(page.getByText(/applied to be your mentee/i)).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(applicantEmail);
    await cleanupByEmail(mentorEmail);
  }
});
