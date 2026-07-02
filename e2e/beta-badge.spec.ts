import { test, expect } from '@playwright/test';

// The app is pre-1.0, so a "beta" badge sits next to the brand wordmark and the
// version (package.json) carries a -beta suffix surfaced by the version footer.
test('landing page shows the beta badge', async ({ page }) => {
  await page.goto('/');
  // The badge renders its label as exact text "beta" (the version footer shows
  // "v0.2.0-beta", which is excluded by the exact match).
  await expect(page.getByText('beta', { exact: true }).first()).toBeVisible();
});
