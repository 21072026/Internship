import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

test('mobile: sidebar is behind a hamburger; opens as a drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await login(page);

  const hamburger = page.getByRole('button', { name: 'Open menu' });
  await expect(hamburger).toBeVisible();
  // Nav link is off-canvas (not in viewport) until the drawer opens
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).not.toBeInViewport();

  await hamburger.click();
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeInViewport();
});

test('desktop: sidebar is visible, no hamburger', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeInViewport();
});
