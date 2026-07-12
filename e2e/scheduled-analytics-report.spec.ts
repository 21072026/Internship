import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Premium Faz 2 (#541): the weekly analytics report email job is a no-op while
// the premiumAnalytics setting is off, and reports sends once enabled (SMTP is
// unset in CI, so sendEmail no-ops — the job still counts recipients). Restores
// the flag in finally.
test('weekly analytics report is locked by default and sends to admins once enabled', async ({ page }) => {
  const adminEmail = uniqueEmail('wa-admin');
  const pw = 'WeeklyPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Weekly Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Flag off → the job reports itself locked and sends nothing.
    const off = await page.request.get('/api/cron');
    expect(off.ok()).toBeTruthy();
    const lockedReport = (await off.json()).analyticsReport;
    expect(lockedReport.locked).toBe(true);
    expect(lockedReport.sent).toBe(0);

    // Enable the tier → the job runs and counts at least this admin.
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'true' } });
    const on = await page.request.get('/api/cron');
    expect(on.ok()).toBeTruthy();
    const report = (await on.json()).analyticsReport;
    expect(report.locked).toBe(false);
    expect(report.sent).toBeGreaterThanOrEqual(1);
  } finally {
    await page.request.put('/api/admin/settings', { data: { premiumAnalytics: 'false' } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
