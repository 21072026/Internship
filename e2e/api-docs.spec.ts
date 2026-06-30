import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can read API documentation linked from integrations', async ({ page }) => {
  const email = uniqueEmail('apidoc-admin');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'ApiDoc Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/api-docs');
    await expect(page.getByText('GET /api/v1/candidates')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Bearer token/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /openapi\.json/i })).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});
