import { test, expect } from '@playwright/test';

// The accessibility conformance report (#2037). Three properties, all for an
// ANONYMOUS visitor — procurement fetches a VPAT without an account:
//   1. the page and its Markdown twin answer 200 with the report in them;
//   2. the statement and the trust page link to it;
//   3. the Markdown is the same document the repository commits (same title,
//      same scope sentence) — the drift itself is pinned by scripts/test/vpat.test.mjs.
// Not @smoke: the PR gate stays small; the scheduled suite covers it.
test('the VPAT page is public and renders every table with evidence', async ({ page }) => {
  await page.goto('/accessibility/vpat');
  await expect(page).toHaveURL(/\/accessibility\/vpat$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Accessibility Conformance Report');
  await expect(page.getByTestId('vpat-table-wcag-a')).toBeVisible();
  await expect(page.getByTestId('vpat-table-wcag-aa')).toBeVisible();
  await expect(page.getByTestId('vpat-table-en-chapter-9')).toBeVisible();
  await expect(page.getByTestId('vpat-table-s508-chapter-5')).toBeVisible();
  await expect(page.getByTestId('vpat-table-en-chapter-5')).toBeVisible();
  // 1.4.3 is a Supports row and therefore carries evidence links.
  const contrast = page.getByTestId('vpat-row-1.4.3');
  await expect(contrast).toContainText('Supports');
  expect(await contrast.locator('a').count()).toBeGreaterThan(0);
  // The scope is stated, never implied.
  await expect(page.getByTestId('vpat-scope')).toContainText('pending evaluation');
  await expect(page.getByTestId('vpat-evidence-table')).toBeVisible();
});

test('the Markdown twin is served unauthenticated with the same report', async ({ request }) => {
  const res = await request.get('/accessibility/vpat.md');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/markdown');
  const body = await res.text();
  expect(body).toContain('# InternshipCRM Accessibility Conformance Report');
  expect(body).toContain('Table 1: Success Criteria, Level A');
  expect(body).toContain('EN 301 549 Report');
  expect(body).toContain('Every other URL of the product is pending evaluation');
  expect(body).not.toContain('@e2e.local');
});

test('the statement and the trust page link to the report', async ({ page }) => {
  await page.goto('/accessibility');
  const link = page.getByTestId('accessibility-vpat-link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/accessibility/vpat');
  await page.goto('/trust');
  await expect(page.getByTestId('trust-docs').getByRole('link', { name: /VPAT 2.5/ })).toHaveAttribute('href', '/accessibility/vpat');
});
