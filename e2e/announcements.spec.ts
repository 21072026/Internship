import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('sending an announcement persists it and shows up in the history list', async ({ page }) => {
  const adminEmail = uniqueEmail('announce-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Announce Admin');
  const uniqueText = `E2E announcement ${Date.now().toString(36)}`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/announcements');
    await page.fill('textarea', uniqueText);

    const postDone = page.waitForResponse(
      (r) => r.url().includes('/api/admin/announcements') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /^Broadcast$/i }).click();
    await postDone;

    // Persisted: shows up in the history panel with the recipient count.
    await expect(page.getByText(uniqueText)).toBeVisible({ timeout: 10_000 });

    const record = await prisma.announcement.findFirst({ where: { text: uniqueText } });
    expect(record).not.toBeNull();
    expect(record?.sentById).toBeTruthy();
    expect(record?.recipientCount).toBeGreaterThan(0);

    // Reloading the page still shows it (proves it's a real DB record, not just local state).
    await page.reload();
    await expect(page.getByText(uniqueText)).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.announcement.deleteMany({ where: { text: uniqueText } });
    await cleanupByEmail(adminEmail);
  }
});
