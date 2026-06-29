import { test, expect } from '@playwright/test';

test('landing page shows features, pipeline and CTAs in English by default', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Connect Talent with/i })).toBeVisible();
  await expect(page.getByText('Everything you need')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pipeline tracking' })).toBeVisible();
  // pipeline diagram stage label
  await expect(page.getByText('Internship', { exact: true }).first()).toBeVisible();
  // "Get Started" sends a new visitor to registration (not sign-in).
  const getStarted = page.getByRole('link', { name: /Get Started/i }).first();
  await expect(getStarted).toBeVisible();
  await expect(getStarted).toHaveAttribute('href', '/auth/register');
});

test('landing page switches to Turkish via the locale cookie', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
  await page.reload();
  await expect(page.getByText('Fırsatla buluştur')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('İhtiyacın olan her şey')).toBeVisible();
});

test('public sign-in page is internationalized', async ({ page }) => {
  await page.goto('/auth/signin');
  await expect(page.getByRole('link', { name: /Forgot password/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Register here/i })).toBeVisible();
});
