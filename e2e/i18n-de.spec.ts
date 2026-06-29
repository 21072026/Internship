import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('German locale translates the admin nav and persists as the user preference', async ({ page }) => {
  const email = uniqueEmail('de-admin');
  const admin = await seedUser(email, 'AdminPass123', 'ADMIN', 'DE Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    await page.goto('/admin');

    // Switch to German via the language switcher.
    await page.getByRole('button', { name: 'de', exact: true }).click();
    await page.waitForLoadState('load');

    // Nav is now German.
    await expect(page.getByRole('link', { name: 'Kandidaten', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'Unternehmen', exact: true })).toBeVisible();

    // The choice is saved as the user's preferred language.
    await expect.poll(async () => {
      const u = await prisma.user.findUnique({ where: { id: admin.id }, select: { preferredLanguage: true } });
      return u?.preferredLanguage;
    }, { timeout: 10_000 }).toBe('de');
  } finally {
    await cleanupByEmail(email);
  }
});
