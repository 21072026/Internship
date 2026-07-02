import { test, expect } from '@playwright/test';

// EPIC K (#424): the consent banner is categorized (necessary/analytics/
// marketing) and stores a versioned, timestamped choice. Needs a clean slate
// so the banner actually shows.
test.use({ storageState: { cookies: [], origins: [] } });

test('customize lets you accept only analytics; choice is stored with version + timestamp', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');

  const banner = page.getByRole('dialog', { name: /privacy/i });
  await expect(banner).toBeVisible({ timeout: 10_000 });

  // Open the per-category panel and accept analytics only.
  await banner.getByRole('button', { name: /customize|özelleştir|anpassen/i }).click();
  await banner.getByRole('checkbox').nth(1).check(); // 0 = necessary (disabled), 1 = analytics
  await banner.getByRole('button', { name: /save preferences|tercihleri kaydet|einstellungen speichern/i }).click();

  await expect(banner).toBeHidden();

  const stored = await page.evaluate(() => localStorage.getItem('cookie_consent'));
  expect(stored).toBeTruthy();
  const parsed = JSON.parse(stored!);
  expect(parsed.version).toBe(2);
  expect(parsed.necessary).toBe(true);
  expect(parsed.analytics).toBe(true);
  expect(parsed.marketing).toBe(false);
  expect(typeof parsed.ts).toBe('string');

  // Choice persists → banner stays hidden on reload.
  await page.reload();
  await expect(page.getByRole('dialog', { name: /privacy/i })).toHaveCount(0);
});
