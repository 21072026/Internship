import { test, expect } from '@playwright/test';

test('landing page shows features, pipeline and CTAs in English by default', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Companies that want experience/i })).toBeVisible();
  await expect(page.getByText('Everything you need')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pipeline tracking' })).toBeVisible();
  // pipeline diagram stage label
  await expect(page.getByText('Internship', { exact: true }).first()).toBeVisible();
  // The mentee CTA sends a new visitor to registration (not sign-in). The hero
  // no longer carries a button — each audience section has its own.
  const menteeCta = page.getByRole('link', { name: /Create a free account/i }).first();
  await expect(menteeCta).toBeVisible();
  await expect(menteeCta).toHaveAttribute('href', '/auth/register');
  // Each of the three audiences gets a card that jumps to its own section.
  await expect(page.getByTestId('role-card')).toHaveCount(3);
});

test('landing page switches to Turkish via the locale cookie', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { document.cookie = 'locale=tr;path=/'; });
  await page.reload();
  await expect(page.getByText('ve arada duran mentorlar.')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('İhtiyacın olan her şey')).toBeVisible();
});

test('public sign-in page is internationalized', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/auth/signin');
  await expect(page.getByRole('link', { name: /Forgot password/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Register here/i })).toBeVisible();
});
