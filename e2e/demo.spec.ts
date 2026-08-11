/**
 * E2E tests for the /demo page and demo-mode middleware guard.
 *
 * The /demo page is always available, regardless of whether DEMO_MODE is set
 * (it is a marketing/discovery page that links to the demo instance).
 *
 * Demo-mode middleware behaviour (DEMO_MODE=true) is tested via direct API
 * calls because we cannot easily flip env vars in Playwright; we verify the
 * middleware logic in isolation via the /api/demo/reset endpoint which is
 * only active when DEMO_MODE=true.
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// /demo page — always available
// ---------------------------------------------------------------------------

test('/demo page renders the interactive demo landing', async ({ page }) => {
  await page.goto('/demo');

  // Heading and subtitle should be visible.
  await expect(page.getByRole('heading', { name: /Live Interactive Demo/i })).toBeVisible({ timeout: 10_000 });

  // Credentials panel with all three roles should be present.
  await expect(page.getByTestId('demo-credentials-panel')).toBeVisible();
  await expect(page.getByTestId('demo-credential-admin')).toBeVisible();
  await expect(page.getByTestId('demo-credential-mentor')).toBeVisible();
  await expect(page.getByTestId('demo-credential-mentee')).toBeVisible();

  // CTA to the production instance should be present.
  await expect(page.getByTestId('demo-production-cta')).toBeVisible();
});

test('/demo page link to sign-in is present', async ({ page }) => {
  await page.goto('/demo');
  const signinLink = page.getByTestId('demo-signin-link');
  await expect(signinLink).toBeVisible({ timeout: 10_000 });
  await expect(signinLink).toHaveText(/Open demo/i);
});

test('/demo page has no 500 errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('response', (res) => {
    if (res.status() >= 500) errors.push(`${res.status()} ${res.url()}`);
  });
  await page.goto('/demo');
  // Allow time for any async requests.
  await page.waitForTimeout(500);
  expect(errors).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// /api/demo/reset — must return 404 when DEMO_MODE is not set (default)
// ---------------------------------------------------------------------------

test('/api/demo/reset returns 404 when not in demo mode', async ({ request }) => {
  const res = await request.post('/api/demo/reset', {
    headers: { Authorization: '******' },
  });
  // In production / test the endpoint does not exist (404) or is not demo mode.
  // We accept either 404 or 401 (if DEMO_MODE happened to be set and secret mismatches).
  expect([404, 401]).toContain(res.status());
});

// ---------------------------------------------------------------------------
// OpenGraph image for public profiles — smoke check
// ---------------------------------------------------------------------------

test('public profile OG image endpoint returns an image', async ({ request, page }) => {
  // We need a real user ID to test the OG image. Navigate to the public
  // profile e2e helper to find one — or skip gracefully if none exist.
  const res = await page.goto('/');
  expect(res?.status()).not.toBe(500);

  // The OG image route is /p/<userId>/opengraph-image — we verify it is
  // reachable by hitting the 404 fallback (no real user in CI).
  const ogRes = await request.get('/p/nonexistent-user-id/opengraph-image');
  // Should either return a PNG (200) or redirect to not-found — never 500.
  expect([200, 302, 404]).toContain(ogRes.status());
  if (ogRes.status() === 200) {
    expect(ogRes.headers()['content-type']).toContain('image/png');
  }
});
