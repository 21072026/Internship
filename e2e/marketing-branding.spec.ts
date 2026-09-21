import { test, expect } from '@playwright/test';

// SaleVali branding on the marketing host (#2356): the accent, the mark, the
// favicon/home-screen icons, the browser tint and the manifest all follow the
// vertical. Host-forged like host-vertical-landing.spec.ts — the default
// MARKETING_HOSTS is 'marketing.ersah.in', so no env change is needed. The
// default host is asserted too: the internship product must be byte-identical.

const MARKETING = { 'x-forwarded-host': 'marketing.ersah.in' };

test('the marketing host wears SaleVali: magenta accent, the V mark, its own icon and tint', async ({ page, request }) => {
  await page.setExtraHTTPHeaders(MARKETING);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'magenta');
  await expect(page.locator('header svg[aria-label="SaleVali"]').first()).toBeVisible();
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#b929cf');
  await expect(page.locator('link[rel="icon"][href="/icon-salevali.svg"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][href="/icon.svg"]')).toHaveCount(0);

  const m = await (await request.get('/manifest.webmanifest', { headers: MARKETING })).json();
  expect(m.name).toBe('SaleVali');
  expect(m.theme_color).toBe('#b929cf');
  const srcs: string[] = m.icons.map((i: { src: string }) => i.src);
  expect(srcs).toContain('/icon-salevali.svg');
  for (const src of srcs) expect((await request.get(src)).status(), `${src} should be served`).toBe(200);
  expect((await request.get('/apple-touch-icon-salevali.png')).status()).toBe(200);
});

test('the sign-in page on the marketing host shows the SaleVali tile, not the cap', async ({ page }) => {
  await page.setExtraHTTPHeaders(MARKETING);
  await page.goto('/auth/signin');
  await expect(page.locator('svg[aria-label="SaleVali"]').first()).toBeVisible();
  await expect(page.locator('svg.lucide-graduation-cap')).toHaveCount(0);
});

test('the default host is unchanged: blue accent, the cap, the internship manifest and icon', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect(page.locator('svg[aria-label="SaleVali"]')).toHaveCount(0);
  await expect(page.locator('header svg.lucide-graduation-cap').first()).toBeVisible();
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#1D4ED8');
  await expect(page.locator('link[rel="icon"][href="/icon.svg"]')).toHaveCount(1);
  const m = await (await request.get('/manifest.webmanifest')).json();
  expect(m.name).toBe('Internship CRM');
  expect(m.theme_color).toBe('#1D4ED8');
  expect((await request.get('/icon.svg')).status()).toBe(200);
});
