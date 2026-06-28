import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a fresh mentee sees the first-run checklist on the dashboard', async ({ page }) => {
  const email = uniqueEmail('checklist');
  await seedUser(email, 'CheckPass123', 'MENTEE', 'Checklist Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'CheckPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await expect(page.getByRole('heading', { name: 'Get started' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Complete your profile')).toBeVisible();
    await expect(page.getByText('Upload your CV')).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
