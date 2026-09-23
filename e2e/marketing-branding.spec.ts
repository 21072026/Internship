import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

// SaleVali branding on the marketing host (#2492): the accent, the mark, the
// favicon/home-screen icons, the browser tint and the manifest all follow the
// vertical. Host-forged like host-vertical-landing.spec.ts — the default
// MARKETING_HOSTS is 'marketing.ersah.in', so no env change is needed. The
// default host is asserted too: the internship product must be byte-identical.

const MARKETING = { 'x-forwarded-host': 'marketing.ersah.in' };

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('the marketing host wears SaleVali: magenta accent, the V mark, its own icon and tint', async ({ page, request }) => {
  await page.setExtraHTTPHeaders(MARKETING);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'magenta');
  await expect(page.locator('header svg[aria-label="SaleVali"]').first()).toBeVisible();
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#b929cf');
  await expect(page.locator('link[rel="icon"][href="/icon-salevali.svg"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][href="/icon.svg"]')).toHaveCount(0);
  // Safari loads no SVG favicon: without a raster entry it falls through to the
  // implicit /favicon.ico, which is the internship cap.
  await expect(page.locator('link[rel="icon"][href="/icon-salevali-192.png"]')).toHaveCount(1);
  // iOS launch screens are a separate, per-mark set (lib/appleSplash.ts).
  const splash = page.locator('link[rel="apple-touch-startup-image"]');
  expect(await splash.count()).toBeGreaterThan(0);
  for (const href of await splash.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href, 'a marketing splash image').toMatch(/-salevali\.png$/);
  }
  expect((await request.get((await splash.first().getAttribute('href'))!)).status()).toBe(200);

  const m = await (await request.get('/manifest.webmanifest', { headers: MARKETING })).json();
  expect(m.name).toBe('SaleVali');
  expect(m.theme_color).toBe('#b929cf');
  const srcs: string[] = m.icons.map((i: { src: string }) => i.src);
  expect(srcs).toContain('/icon-salevali.svg');
  for (const src of srcs) expect((await request.get(src)).status(), `${src} should be served`).toBe(200);
  expect((await request.get('/apple-touch-icon-salevali.png')).status()).toBe(200);
  // The long-press shortcuts sit on the brand tile, not the internship blue one.
  const shortcutSrcs: string[] = m.shortcuts.flatMap((s: { icons: { src: string }[] }) => s.icons.map((i) => i.src));
  expect(shortcutSrcs).toHaveLength(3);
  for (const src of shortcutSrcs) {
    expect(src).toMatch(/-salevali-96\.png$/);
    expect((await request.get(src)).status(), `${src} should be served`).toBe(200);
  }
});

// /messages carries its own viewport export (viewportFit: cover), which
// replaces the root one — so its tint has to follow the vertical by itself.
// Session-first: the signed-in user's org is MARKETING, so this holds on any
// host; the marketing host header only keeps the test honest about the chrome.
test('signed in to a marketing org, /messages keeps the SaleVali tint and accent', async ({ page }) => {
  const org = await prisma.organization.create({
    data: { slug: `sv-tint-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, name: 'SaleVali Tint Org', vertical: 'MARKETING' },
  });
  const email = uniqueEmail('sv-tint');
  const pw = 'TintPass123';
  const user = await seedUser(email, pw, 'ADMIN', 'Tint Admin');
  await prisma.user.update({ where: { id: user.id }, data: { orgId: org.id } });
  try {
    await page.setExtraHTTPHeaders(MARKETING);
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    await page.goto('/messages');
    await expect(page).toHaveURL(/\/messages/);
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#b929cf');
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'magenta');
  } finally {
    await cleanupByEmail(email);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
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
  const shortcutSrcs: string[] = m.shortcuts.flatMap((s: { icons: { src: string }[] }) => s.icons.map((i) => i.src));
  for (const src of shortcutSrcs) expect(src).not.toMatch(/salevali/);
  for (const href of await page.locator('link[rel="apple-touch-startup-image"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href).not.toMatch(/salevali/);
  }
});

/**
 * The other product's pages are not served here at all (#2540).
 *
 * The overlay renames a word; it cannot rewrite a page. `/features` opened with
 * "InternshipCRM neler yapabilir" and went on to list self-service mentee
 * applications and weekly internship reports; `/pricing` carried
 * "Fiyatlandırma — InternshipCRM" in the tab title and explained a price
 * metered in matched mentor/mentee pairs; `/release-notes` published 202 lines
 * of the internship changelog. A marketing visitor reached the first two from
 * this host's own header.
 *
 * Asserted as a 404 rather than "the word is gone": the pages are the wrong
 * product's, so any amount of renaming still leaves a marketing visitor reading
 * about interns.
 */
const INTERNSHIP_ONLY = ['/features', '/pricing', '/for-companies', '/apply-as-mentor', '/release-notes', '/projects'];

test('internship-product pages 404 on the marketing host, and are linked from nowhere on it', async ({ page }) => {
  test.slow();
  await page.setExtraHTTPHeaders(MARKETING);

  for (const path of INTERNSHIP_ONLY) {
    // The headers go on the request, not via setExtraHTTPHeaders: that applies
    // to what the PAGE fetches, while `page.request` is the context's own API
    // client and would otherwise ask as the internship host.
    const res = await page.request.get(path, { headers: MARKETING });
    expect(res.status(), `${path} must not be served on a marketing host`).toBe(404);
  }

  // …and no chrome offers them, so nobody arrives at one by clicking.
  await page.goto('/');
  for (const path of INTERNSHIP_ONLY) {
    await expect(page.locator(`a[href="${path}"]`), `the marketing chrome links to ${path}`).toHaveCount(0);
  }
  // The sign-in page carries its own mentor invitation.
  await page.goto('/auth/signin');
  await expect(page.getByTestId('apply-as-mentor-link')).toHaveCount(0);
});

test('the internship host still serves every one of them', async ({ page }) => {
  test.slow();
  // The other half of the guarantee: this change must be invisible to the
  // product that owns these pages. A gate that 404s both hosts would pass the
  // test above and take the live site down.
  for (const path of INTERNSHIP_ONLY) {
    const res = await page.request.get(path);
    expect(res.status(), `${path} must still be served on the internship host`).toBe(200);
  }
  await page.goto('/');
  await expect(page.locator('a[href="/features"]').first()).toBeVisible();
});
