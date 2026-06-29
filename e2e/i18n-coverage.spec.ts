import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('previously hardcoded admin strings are translated in Turkish', async ({ page }) => {
  const email = uniqueEmail('i18ncov-admin');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'Cov Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Switch to Turkish.
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });

    await page.goto('/admin/mentorship');
    await expect(page.getByRole('button', { name: 'Mentorluk ata' })).toBeVisible({ timeout: 10_000 });

    await page.goto('/admin/companies');
    await expect(page.getByRole('button', { name: 'Şirket ekle' })).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
