import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, apiSession, MARKETING_HOST } from './helpers/auth';

// SaleVali branding on the marketing host (#2492): the accent, the mark, the
// favicon/home-screen icons, the browser tint and the manifest all follow the
// vertical. Host-forged like host-vertical-landing.spec.ts — the default
// MARKETING_HOSTS is 'marketing.bcsit-gmbh.de', so no env change is needed. The
// default host is asserted too: the internship product must be byte-identical.

const MARKETING = { 'x-forwarded-host': 'marketing.bcsit-gmbh.de' };

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
// A MARKETING-org account signs in on the marketing host only (#2590: the URL
// decides the product), so the header is set before sign-in and kept for the
// /messages navigation — that host is both the login's world and the chrome's.
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

// The old "the signed-in user's org beats the host" rule is gone (#2590): the
// URL decides the product, and a session only exists on its own world's host.
// An INTERNSHIP account signed in on the default host is therefore NOT a session
// on the marketing host — that host is still the marketing product's anonymous
// chrome — while on its own host it keeps the internship branding.
test('an INTERNSHIP session presented on the marketing host is no session there — the host decides the chrome', async ({ request }) => {
  const email = uniqueEmail('sv-world');
  const pw = 'WorldPass123';
  await seedUser(email, pw, 'ADMIN', 'World Admin');
  try {
    const login = await signInViaApi(request, email, pw);
    expect(login.ok, `sign-in on the default host: ${login.error}`).toBe(true);
    expect((await apiSession(request))?.user.email).toBe(email);
    expect(await apiSession(request, MARKETING_HOST), 'a session is not valid on the other world\'s host').toBeNull();

    const html = await (await request.get('/auth/signin', { headers: MARKETING })).text();
    expect(html).toContain('SaleVali');
  } finally {
    await cleanupByEmail(email);
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
