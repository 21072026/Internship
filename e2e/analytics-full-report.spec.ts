import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 2 (#540): the full analytics report page is locked until the
// premiumAnalytics setting is on; enabled, it renders funnel/trends/mentor/
// cohort sections ready for the browser's print-to-PDF pipeline. Restores the
// flag in finally.
test('full report page is locked by default and renders once premium analytics is enabled', async ({ page }) => {
  const adminEmail = uniqueEmail('report-admin');
  const pw = 'ReportPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Report Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Locked by default — and the premium export buttons are hidden on the
    // analytics page.
    await page.goto('/admin/analytics/report');
    await expect(page.getByTestId('report-locked')).toBeVisible({ timeout: 10_000 });
    await page.goto('/admin/analytics');
    await expect(page.getByTestId('full-report-link')).toHaveCount(0);

    // Enable the tier → report renders, buttons appear.
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } });

    await page.goto('/admin/analytics/report');
    await expect(page.getByTestId('full-report')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: /Full analytics report/i })).toBeVisible();

    await page.goto('/admin/analytics');
    await expect(page.getByTestId('full-report-link')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('full-report-excel')).toBeVisible();
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
