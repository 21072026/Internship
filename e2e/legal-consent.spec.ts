import { test, expect } from '@playwright/test';

// This spec needs the banner to actually show, so start from a clean slate
// (the global default pre-seeds consent for every other spec).
test.use({ storageState: { cookies: [], origins: [] } });

test('cookie consent banner appears and dismisses; choice is stored', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');

  const banner = page.getByRole('dialog', { name: /privacy/i });
  await expect(banner).toBeVisible({ timeout: 10_000 });

  await banner.getByRole('button', { name: /Accept all/i }).click();
  await expect(banner).toBeHidden();

  // Choice persisted as a cookie → banner stays hidden on reload.
  await page.reload();
  await expect(page.getByRole('dialog', { name: /privacy/i })).toHaveCount(0);
});

test('terms of service page is reachable and linked from the footer', async ({ page }) => {
  await page.goto('/terms');
  await expect(page.getByRole('heading', { name: /Terms of Service/i })).toBeVisible();
});

test('registration requires accepting privacy and terms', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/auth/register');
  // Dismiss the cookie banner so it doesn't overlap the form.
  await page.getByRole('button', { name: /Necessary only/i }).click().catch(() => {});

  await page.fill('input[name="fullName"]', 'Consent Tester');
  await page.fill('input[name="email"]', `consent-${Date.now()}@example.com`);
  await page.fill('input[name="password"]', 'StrongPass123');
  await page.fill('input[name="confirmPassword"]', 'StrongPass123');

  // Submitting without ticking consent keeps us on the register page.
  await page.getByRole('button', { name: /Create Account/i }).click();
  await expect(page).toHaveURL(/\/auth\/register/);
  await expect(page.getByText(/must accept the privacy and terms/i)).toBeVisible({ timeout: 5_000 });
});
