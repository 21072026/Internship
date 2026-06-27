import { test, expect } from '@playwright/test';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test('sidebar footer (Sign Out) stays in the viewport on long pages', async ({ page }) => {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

  // Mentorships is a long list; the sticky sidebar should keep Sign Out on screen.
  await page.goto('/admin/mentorship');
  await page.waitForTimeout(1000);
  await expect(page.getByRole('link', { name: 'Sign Out', exact: true })).toBeInViewport();
});
