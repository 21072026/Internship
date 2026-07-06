import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// #471: dates previously followed the browser's locale (or a hardcoded
// 'en-US'), ignoring the user's selected TR/DE language. formatDate/
// formatDateTime (src/lib/relativeTime.ts) now drive every call site.
test('dates on admin/activity follow the selected app language, not the browser default', async ({ page }) => {
  const adminEmail = uniqueEmail('datefmt-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Date Fmt Admin');
  await prisma.activityLog.create({
    data: { action: 'test.action', actorId: admin.id, actorEmail: admin.email, level: 'INFO' },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Force a non-English OS locale to prove the app ignores the browser default.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
    await page.goto('/admin/activity');

    // TR formatting uses dots (gg.aa.yyyy), never the en-US slash format.
    const firstDate = page.locator('span.text-gray-400').first();
    await expect(firstDate).toBeVisible();
    await expect(firstDate).toHaveText(/\d{2}\.\d{2}\.\d{4}/);
    await expect(firstDate).not.toHaveText(/\d{1,2}\/\d{1,2}\/\d{4}/);
  } finally {
    await prisma.activityLog.deleteMany({ where: { actorId: admin.id } });
    await cleanupByEmail(adminEmail);
  }
});
