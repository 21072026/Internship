import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin sets a mentor expertise and the mentors list shows it', async ({ page }) => {
  const mentorEmail = uniqueEmail('sm-mentor');
  const mentor = await seedUser(mentorEmail, 'Pass1234!', 'MENTOR', 'SM Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // Admin sets the mentor's expertise + capacity via the users endpoint.
    const patch = await page.request.patch(`/api/users/${mentor.id}`, {
      data: { skills: ['Kotlin', 'AWS', 'Go'], mentorCapacity: 5 },
    });
    expect(patch.ok()).toBeTruthy();

    // The mentors list shows the expertise chips.
    await page.goto('/admin/mentors');
    // Target the mentors search box (the admin layout also has a "Filter menu" one).
    await page.getByPlaceholder(/name, email or skill/i).fill('SM Mentor');
    await expect(page.getByText('Kotlin', { exact: true })).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
