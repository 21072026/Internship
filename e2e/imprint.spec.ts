import { test, expect } from '@playwright/test';

/**
 * #1396 — the deployment says who runs it.
 *
 * The identity itself comes from `OPERATOR_*` env vars, so what these tests can
 * assert depends on how the app under test was started. Both states matter and
 * both are covered:
 *
 *   unset (CI, local dev)  the page exists, is reachable from the footer, and
 *                          says plainly that no imprint has been published —
 *                          never the old placeholder promising it later;
 *   set (production)       the operator's name and email are on the page and
 *                          the privacy notice names the same controller.
 *
 * The regression this guards against is the one that was live for months: a
 * privacy notice whose "Contact" section said the operator would fill it in
 * before production use.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const CONFIGURED = Boolean(process.env.OPERATOR_NAME && process.env.OPERATOR_EMAIL);

test('the imprint page is public and reachable from the footer', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/privacy');

  const link = page.getByTestId('public-footer').getByRole('link', { name: /imprint|künye|impressum/i });
  await expect(link).toHaveAttribute('href', '/imprint');

  await page.goto('/imprint');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('the privacy notice no longer defers its controller to "before production use"', async ({ page }) => {
  await page.goto('/privacy');
  const body = (await page.locator('main').innerText()).toLowerCase();

  // The exact placeholders that shipped to production, in all three languages.
  expect(body).not.toContain('before production use');
  expect(body).not.toContain('üretim kullanımı öncesinde');
  expect(body).not.toContain('vor dem produktiveinsatz');

  await expect(page.getByTestId('privacy-imprint-link')).toBeVisible();
});

test('an instance with no operator configured says so instead of naming nobody', async ({ page }) => {
  test.skip(CONFIGURED, 'OPERATOR_* is configured for this run — see the configured-instance test');

  await page.goto('/imprint');
  await expect(page.getByTestId('imprint-unset')).toBeVisible();
  await expect(page.getByTestId('imprint-details')).toHaveCount(0);
});

test('a configured instance publishes the operator and a working contact address', async ({ page }) => {
  test.skip(!CONFIGURED, 'OPERATOR_* not set for this run — see the unconfigured-instance test');

  await page.goto('/imprint');
  await expect(page.getByTestId('imprint-unset')).toHaveCount(0);
  await expect(page.getByTestId('imprint-operator')).toContainText(process.env.OPERATOR_NAME!);

  // Reachable without solving a puzzle: a real mailto, not an obfuscated span.
  await expect(page.getByTestId('imprint-email').getByRole('link')).toHaveAttribute(
    'href',
    `mailto:${process.env.OPERATOR_EMAIL}`
  );

  // The privacy notice must name the SAME controller — two pages disagreeing
  // about who is responsible is worse than one page saying nothing.
  await page.goto('/privacy');
  await expect(page.locator('main')).toContainText(process.env.OPERATOR_NAME!);
});
