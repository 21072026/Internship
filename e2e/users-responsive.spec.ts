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
    // The row sits below the fold since the Admin tiers panel (#3454) took the
    // top of the page, so bring it up vertically first. The claim under test is
    // horizontal: on a 390px screen the button is not clipped off the right edge.
    await loginAs.scrollIntoViewIfNeeded();
    await expect(loginAs).toBeInViewport();
    const box = await loginAs.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
