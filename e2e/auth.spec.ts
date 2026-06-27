import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test('unauthenticated access to /admin redirects to sign in', async ({ page }) => {
  await page.goto('/admin');
  await page.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 15_000 });
  await expect(page.locator('input[type="password"]')).toBeVisible();
});

test('wrong credentials keep the user on the sign-in page', async ({ page }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', 'nobody@e2e.local');
  await page.fill('input[type="password"]', 'wrong-password-123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(3000);
  expect(page.url()).toContain('/auth/signin');
});

test('authenticated admin sees a Sign Out control', async ({ page }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: /sign out/i })).toBeVisible();
});

test('admin sidebar links to the invite page', async ({ page }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
  await page.goto('/admin');
  const inviteLink = page.getByRole('link', { name: 'Send Invitation', exact: true });
  await expect(inviteLink).toBeVisible();
  await inviteLink.click();
  await page.waitForURL((u) => u.pathname.includes('/admin/invite'), { timeout: 15_000 });
  await expect(page.locator('input[type="email"]')).toBeVisible();
});
