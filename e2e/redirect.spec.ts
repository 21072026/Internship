import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test('signed-in user is redirected away from / and /auth/signin', async ({ page }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

  // Home page redirects to the role dashboard
  await page.goto('/');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 15_000 });

  // Sign-in page too
  await page.goto('/auth/signin');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 15_000 });
  expect(page.url()).not.toContain('/auth/signin');
});
