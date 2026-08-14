import { test, expect } from '@playwright/test';

// Public demo instance (#966).
//
// The suite runs WITHOUT DEMO_MODE, which is the configuration production and
// preview use — so what these tests assert is that the whole feature is inert
// there. That is the property worth guarding: a demo banner or a /demo page
// appearing on crm.ersah.in would be a live incident, and the write blocklist
// firing on a real tenant would break their account settings.
//
// The demo-mode-ON behaviour is covered where it can be tested deterministically
// without a second web server:
//   - the block list is checked against the live routes by
//     `npm run check:demo-blocklist` (a renamed route is the way it really breaks);
//   - the reset script's refusals are covered by
//     infra/test/reset-demo-guard.test.sh, including the production and preview
//     database names.

test('the demo banner is absent when DEMO_MODE is off', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('demo-mode-banner')).toHaveCount(0);

  // Also on a signed-out app route, since the banner lives in the root layout
  // and would otherwise show up on every page in the product.
  await page.goto('/auth/signin');
  await expect(page.getByTestId('demo-mode-banner')).toHaveCount(0);
});

test('/demo is not reachable when DEMO_MODE is off', async ({ page }) => {
  const res = await page.goto('/demo');
  expect(res?.status()).toBe(404);
  await expect(page.getByTestId('demo-credentials')).toHaveCount(0);
});

// PUT /api/account and POST /api/avatar are the first entries in each half of
// the blocklist (account security, uploads). With DEMO_MODE off they must reach
// their own handlers — whatever those decide — and must never answer with the
// demo refusal, which would mean real users cannot change their password or
// upload a CV.
//
// The status is deliberately not asserted: it depends on whether the request
// context happens to hold a session (401 anonymous, 400 for a bad payload), and
// pinning it would make this fail for reasons that have nothing to do with demo
// mode. The response body is the assertion that carries the meaning.
test('account writes are not demo-blocked on a normal deployment', async ({ page }) => {
  const res = await page.request.put('/api/account', { data: { email: 'someone@example.com' } });
  expect(await res.text()).not.toContain('shared demo');
});

test('upload writes are not demo-blocked on a normal deployment', async ({ page }) => {
  const res = await page.request.post('/api/avatar', { data: {} });
  expect(await res.text()).not.toContain('shared demo');
});
