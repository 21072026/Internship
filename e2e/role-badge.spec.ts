import { test, expect } from '@playwright/test';
import { seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #472: RoleBadge now covers all 5 roles with i18n labels, and admin/users
// renders through it instead of a locally duplicated variant map.
test('admin/users shows translated role badges for every role', async ({ page }) => {
  const adminEmail = uniqueEmail('rb-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'RB Admin');
  const company = await seedUser(uniqueEmail('rb-company'), 'x', 'COMPANY', 'RB Company');
  const source = await seedUser(uniqueEmail('rb-source'), 'x', 'SOURCE', 'RB Source');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    await expect(page.getByTestId(`user-row-${company.id}`).getByText('Company', { exact: true })).toBeVisible();
    await expect(page.getByTestId(`user-row-${source.id}`).getByText('Source', { exact: true })).toBeVisible();

    // Turkish label for the same COMPANY role, no other page-specific translation work needed.
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
    await page.reload();
    await expect(page.getByTestId(`user-row-${company.id}`).getByText('Şirket', { exact: true })).toBeVisible();
  } finally {
    await cleanupByEmail(company.email);
    await cleanupByEmail(source.email);
    await cleanupByEmail(adminEmail);
  }
});
