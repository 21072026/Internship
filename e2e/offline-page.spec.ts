import { test, expect } from '@playwright/test';

test('offline fallback page renders and is public', async ({ page }) => {
  await page.goto('/offline');
  await expect(page.getByRole('heading', { name: /offline/i })).toBeVisible({ timeout: 10_000 });
  const homeLink = page.getByRole('link', { name: 'crm.ersah.in' });
  await expect(homeLink).toBeVisible();
  await expect(homeLink).toHaveAttribute('href', 'https://crm.ersah.in');
});

test('the web manifest is served', async ({ page }) => {
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.display).toBe('standalone');
});
