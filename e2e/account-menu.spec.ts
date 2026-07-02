import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

// #410: the sidebar footer collapses into a single account menu. Sign-out,
// language and theme live inside a popover, not stacked in the footer.
test('sidebar account menu holds sign-out, language and theme behind one trigger', async ({ page }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

  await page.goto('/admin');

  const trigger = page.locator('button[aria-haspopup="menu"]');
  await expect(trigger).toBeVisible();

  // Collapsed: the sign-out action is not shown until the menu opens.
  await expect(page.getByRole('menuitem', { name: /sign out|çıkış/i })).toHaveCount(0);

  await trigger.click();

  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /sign out|çıkış/i })).toBeVisible();
  // Language + theme controls moved inside the menu.
  await expect(menu.getByRole('button', { name: 'DE' })).toBeVisible();
});
