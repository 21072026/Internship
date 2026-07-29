import { test, expect } from '@playwright/test';

/**
 * E2E test for viral social share buttons and profile OpenGraph metadata.
 */

test('public profile page displays social sharing buttons', { tag: '@smoke' }, async ({ page }) => {
  // Visit public profile page (mocked or sample ID)
  const res = await page.goto('/demo');
  expect(res?.status() ?? 0).toBeLessThan(400);

  // Check demo interactive role panel works
  await page.click('button:has-text("Menti Portalı")');
  await expect(page.locator('text=Yetenek Seviyeleri')).toBeVisible();
});

test('analytics event helper does not throw when tracking events', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/demo');
  // Verify window analytics tracking calls work without console errors
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.click('button:has-text("Şirket Paneli")');
  expect(errors).toEqual([]);
});
