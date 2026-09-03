import { test, expect, type Page } from '@playwright/test';

/**
 * The public accessibility conformance statement (#2035).
 *
 * Three properties are worth a test, and only three:
 *
 *  1. it renders **anonymously** — a conformance statement behind a login is not
 *     published, and EN 301 549 procurement looks for it without an account;
 *  2. the **limitations list is non-empty** — a statement that claims WCAG 2.2 AA
 *     and names no open defect is a marketing claim. That list emptying out is
 *     the failure mode this page exists to prevent, so it is asserted rather
 *     than trusted;
 *  3. it renders in **all three locales** — the copy is long and lives in a
 *     server-only namespace, which is exactly the shape that silently loses a
 *     locale.
 *
 * The axe scan of this page lives in e2e/a11y-scan.spec.ts (it is one of the
 * pages in e2e/a11y-baseline.json), not here — that spec owns the baseline
 * bookkeeping. Not @smoke: the PR gate stays small.
 */

/** The locale cookie wins over the user preference; it needs an origin first. */
async function setLocale(page: Page, locale: 'tr' | 'de') {
  await page.goto('/');
  await page.evaluate((l) => { document.cookie = `locale=${l};path=/`; }, locale);
}

test('the accessibility statement is public and names its own open defects', async ({ page }) => {
  await page.goto('/accessibility');

  // Anonymous: no redirect to sign-in.
  await expect(page).toHaveURL(/\/accessibility$/);

  // Partial conformance, stated up front — never a bare "we are accessible".
  await expect(page.getByTestId('accessibility-status')).toContainText('WCAG 2.2');

  // The honest half. Each entry is a real limitation with, where one exists, the
  // issue that owns it.
  const limitations = page.getByTestId('accessibility-limitations').locator('li');
  expect(await limitations.count()).toBeGreaterThan(0);

  // Every "we do this" claim carries the file or workflow that backs it.
  const evidence = page.getByTestId('accessibility-evidence').locator('li');
  expect(await evidence.count()).toBeGreaterThan(0);

  // A feedback channel a reader can actually use.
  await expect(page.getByTestId('accessibility-feedback')).not.toBeEmpty();
});

test('the statement is reachable from the public footer', async ({ page }) => {
  await page.goto('/');
  const link = page.getByTestId('public-footer').locator('a[href="/accessibility"]');
  await expect(link).toHaveCount(1);
});

for (const locale of ['tr', 'de'] as const) {
  test(`the accessibility statement renders in ${locale}`, async ({ page }) => {
    await setLocale(page, locale);
    await page.goto('/accessibility');

    const heading = page.locator('h1');
    await expect(heading).toBeVisible();
    // Not the English title — proof the namespace really is translated and not
    // falling back.
    await expect(heading).not.toHaveText('Accessibility');

    const limitations = page.getByTestId('accessibility-limitations').locator('li');
    expect(await limitations.count()).toBeGreaterThan(0);
  });
}
