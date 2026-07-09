import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail, prisma } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// P0 regression guard: on mobile the sidebar is an off-canvas drawer. Tapping
// the account menu must open its popover (with sign-out) — it used to close the
// whole drawer, leaving mobile users unable to reach sign-out.
test('mobile: tapping the account menu opens sign-out without closing the drawer', async ({ page }) => {
  const adminEmail = uniqueEmail('mobile-acct');
  const pw = 'MobilePass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Mobile Admin');

  try {
    await page.setViewportSize({ width: 390, height: 820 });
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Open the off-canvas drawer.
    await page.getByRole('button', { name: 'Open menu' }).click();

    const accountToggle = page.getByRole('button', { name: 'Account', exact: true });
    await expect(accountToggle).toBeVisible({ timeout: 10_000 });

    // Tapping the account toggle opens the popover — the drawer stays open.
    await accountToggle.click();

    const signOut = page.getByRole('link', { name: 'Sign Out' });
    await expect(signOut).toBeVisible();
    // The drawer is still open (the account toggle remains visible).
    await expect(accountToggle).toBeVisible();
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
