import { test, expect } from '@playwright/test';
import { gotoSettled } from './helpers/auth';

// The public developer portal (#1992): reachable without a session, rendered
// from the PUBLIC spec (every path it lists), and never a window onto the admin
// document — that one maps every admin action and guard and stays gated.

test('/developers renders signed-out from the public spec, and the admin spec stays gated', { tag: '@smoke' }, async ({ page, request }) => {
  const spec = await (await request.get('/api/v1/openapi.json')).json();
  const paths = Object.keys(spec.paths as Record<string, unknown>);
  expect(paths.length).toBeGreaterThan(5);
  // The spec's version is the deployment's, and the lifecycle policy is published in it.
  expect(spec.info.version).not.toBe('1.0.0');
  expect(spec['x-lifecycle'].deprecationWindowMonths).toBe(6);
  expect(spec['x-lifecycle'].deprecationHeaders).toEqual(['Deprecation', 'Sunset']);

  expect((await page.request.get('/developers')).status()).toBe(200);
  await gotoSettled(page, '/developers');
  const endpoints = page.getByTestId('developers-endpoints');
  await expect(endpoints).toBeVisible();
  const text = (await endpoints.textContent()) ?? '';
  for (const p of paths) expect(text, `public path ${p} is listed`).toContain(`/api/v1${p}`);
  await expect(page.getByTestId('developers-errors')).toContainText('insufficient_scope');
  await expect(page.getByTestId('developers-webhook-recipe')).toContainText('timingSafeEqual');
  await expect(page.getByTestId('developers-deprecations')).toContainText('2027-01-31');

  // The sandbox key is minted only on the public demo (#1992): this deployment
  // is not one, so the page points there and the route does not exist here.
  await expect(page.getByTestId('developers-sandbox-demo-link')).toBeVisible();
  await expect(page.getByTestId('developers-sandbox-button')).toHaveCount(0);
  expect((await request.post('/api/developers/sandbox-key')).status()).toBe(404);

  // Nothing of the admin surface leaks onto the public page…
  const html = await page.content();
  expect(html).not.toContain('/api/admin/');
  // …and the admin document itself still refuses an anonymous caller.
  const admin = await request.get('/api/admin/openapi');
  expect([401, 403]).toContain(admin.status());
});
