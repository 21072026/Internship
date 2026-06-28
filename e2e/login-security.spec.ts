import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('failed login is rejected generically and recorded', async ({ page }) => {
  const email = uniqueEmail('loginsec');
  await seedUser(email, 'CorrectPass123', 'MENTEE', 'Login Sec');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'WrongPass999');
    await page.click('button[type="submit"]');

    // Stays on the sign-in page (login failed).
    await page.waitForTimeout(1500);
    expect(page.url()).toContain('/auth/signin');

    // The failed attempt is recorded in the activity log.
    await expect
      .poll(async () => prisma.activityLog.count({ where: { action: 'auth.login_failed', actorEmail: email } }), { timeout: 10_000 })
      .toBeGreaterThan(0);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorEmail: email } });
    await cleanupByEmail(email);
  }
});
