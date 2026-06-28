import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('invite page links to Companies for company logins and omits Company role', async ({ page }) => {
  const email = uniqueEmail('invhint');
  await seedUser(email, 'AdminPass123', 'ADMIN', 'Invite Admin');
  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/invite');
    // Hint links to the Companies page.
    const link = page.getByRole('link', { name: 'Companies →' });
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toHaveAttribute('href', '/admin/companies');

    // The role select offers Mentee/Mentor/Admin but not Company.
    const roleSelect = page.getByLabel(/Role/);
    await expect(roleSelect.locator('option', { hasText: 'Mentor' })).toHaveCount(1);
    await expect(roleSelect.locator('option', { hasText: 'Company' })).toHaveCount(0);
  } finally {
    await cleanupByEmail(email);
  }
});
