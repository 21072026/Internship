import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('German is available in the switcher and a saved preference is applied at sign-in', async ({ page }) => {
  const email = uniqueEmail('de-admin');
  const admin = await seedUser(email, 'AdminPass123', 'ADMIN', 'DE Admin');
  // The user prefers German (as set from account settings).
  await prisma.user.update({ where: { id: admin.id }, data: { preferredLanguage: 'de' } });

  try {
    await page.context().clearCookies(); // no explicit locale cookie → preference applies
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    await page.goto('/admin');

    // The admin nav renders in German because of the saved preference.
    await expect(page.getByRole('link', { name: 'Kandidaten', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'Unternehmen', exact: true })).toBeVisible();

    // A DE option is offered by the language switcher (inside the account menu).
    await page.locator('button[aria-haspopup="menu"]').click();
    await expect(page.getByRole('button', { name: 'de', exact: true })).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
