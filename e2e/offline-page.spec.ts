import { test, expect } from '@playwright/test';

test('offline fallback page renders and is public', async ({ page }) => {
  await page.goto('/offline');
  await expect(page.getByRole('heading', { name: /offline/i })).toBeVisible({ timeout: 10_000 });
  // The one link is RELATIVE (#2609): this page is precached per origin and the
  // marketing host installs as its own PWA, so an absolute internship URL sent
  // those users to the wrong product. Asserted as a relative href rather than a
  // hostname precisely so it cannot be re-pinned to one domain.
  const homeLink = page.getByRole('link', { name: 'Go to the home page' });
  await expect(homeLink).toBeVisible();
  await expect(homeLink).toHaveAttribute('href', '/');
  await expect(page.locator('a[href^="http"]')).toHaveCount(0);
});

test('the offline page carries no internship domain on a marketing host', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'x-forwarded-host': 'marketing.bcsit-gmbh.de' });
  await page.goto('/offline');
  await expect(page.getByRole('heading', { name: /offline/i })).toBeVisible({ timeout: 10_000 });
  expect(await page.content()).not.toContain('interncrm.com');
});

test('the web manifest is served', async ({ page }) => {
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.display).toBe('standalone');
});
