import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can open the Mentors list and see a mentor', async ({ page }) => {
  const mentorEmail = uniqueEmail('mentor');
  await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Listed Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin');
    await page.getByRole('link', { name: 'Mentors', exact: true }).click();
    await page.waitForURL((u) => u.pathname.includes('/admin/mentors'), { timeout: 15_000 });

    await expect(page.getByText('Listed Mentor')).toBeVisible();
    await expect(page.getByText(mentorEmail)).toBeVisible();
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});
