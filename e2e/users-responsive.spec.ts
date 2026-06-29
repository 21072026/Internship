import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the users page is usable on a mobile viewport (Login as reachable)', async ({ page }) => {
  const adminEmail = uniqueEmail('resp-admin');
  const menteeEmail = uniqueEmail('resp-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Resp Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Resp Mentee');

  try {
    await page.setViewportSize({ width: 390, height: 820 });
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    const row = page.getByTestId(`user-row-${mentee.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    // The action button is reachable (not clipped off-screen) on mobile.
    const loginAs = row.getByRole('button', { name: 'Login as' });
    await expect(loginAs).toBeInViewport();
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
