import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test('language switcher toggles the admin nav between EN and TR', async ({ page }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
  await page.goto('/admin');

  // Default locale is English (exact avoids matching the "Send Invitations" card)
  await expect(page.getByRole('link', { name: 'Send Invitation', exact: true })).toBeVisible();

  // Switch to Turkish — the switcher lives in the account menu; open it, then
  // clicking TR sets a cookie and reloads.
  await page.locator('button[aria-haspopup="menu"]').click();
  await page.getByRole('button', { name: 'tr' }).click();
  await page.waitForLoadState('load');
  await expect(page.getByRole('link', { name: 'Davet Gönder', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Adaylar', exact: true })).toBeVisible();

  // Page content (not just nav) is translated too
  await expect(page.getByRole('heading', { name: 'Yönetim Paneli', level: 1 })).toBeVisible();

  // Preference persists across navigations (cookie-based)
  await page.goto('/admin/mentorship');
  await expect(page.getByRole('link', { name: 'Davet Gönder', exact: true })).toBeVisible();
});
