import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('sign-in is recorded in the activity log and visible to admins', async ({ page }) => {
  const email = uniqueEmail('actlog');
  await seedUser(email, 'ActLogPass123', 'ADMIN', 'Activity Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'ActLogPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // The login was logged.
    await expect
      .poll(async () => prisma.activityLog.count({ where: { action: 'auth.login', actorEmail: email } }))
      .toBeGreaterThan(0);

    // The admin activity viewer shows entries.
    await page.goto('/admin/activity');
    await expect(page.getByRole('heading', { name: /Activity log/i }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('auth.login').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: email } });
    await cleanupByEmail(email);
  }
});
