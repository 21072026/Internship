import { test, expect } from '@playwright/test';

// EPIC E (#418): the 404 page must be localized (was hardcoded English) and
// render our own styled page rather than Next's default.
test('unknown routes render the localized 404 page with a home link', async ({ page }) => {
  const res = await page.goto('/this-route-truly-does-not-exist-xyz');
  expect(res?.status()).toBe(404);

  // Our custom page shows the big 404 and a link back home (locale-independent
  // structure; text comes from the active dictionary).
  await expect(page.getByText('404')).toBeVisible();
  await expect(page.getByRole('link', { name: /home|start|ana sayfa|startseite/i })).toBeVisible();
});
