import { test, expect } from '@playwright/test';

// EPIC E (#418): the 404 page must be localized (was hardcoded English) and
// render our own styled page rather than Next's default.
test('unknown routes render the localized 404 page with a home link', async ({ page }) => {
  const res = await page.goto('/this-route-truly-does-not-exist-xyz');
  expect(res?.status()).toBe(404);

  // Our custom page shows the big 404 and a link back home (locale-independent
  // structure; text comes from the active dictionary).
  await expect(page.getByText('404')).toBeVisible();
  // Anchored (^...$) so this matches only the page's own "Back to home" link
  // (t.notFound.backHome, EN/TR/DE) — not the PublicShell header's logo link,
  // whose aria-label "InternshipCRM — go to the home page" also contains
  // "home" and made the unanchored version of this locator resolve to 2
  // elements (strict-mode violation).
  await expect(
    page.getByRole('link', { name: /^(back to home|ana sayfaya dön|zurück zur startseite)$/i })
  ).toBeVisible();
});
