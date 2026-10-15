import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi, apiSession, MARKETING_HOST, asHost } from './helpers/auth';
import { BRAND_E2E_HOST } from './helpers/hosts';
import { bindSyntheticBrand, SYNTHETIC_BRAND, type BoundBrand } from './helpers/brand';

// The marketing vertical's chrome (#2492, #2922). A marketing host that no
// branded organization is bound to wears the NEUTRAL default — "coreCRM", the
// product blue, the slate trend-line icon set — and a host bound to an
// organization with brand data wears that organization's brand, palette
// included. Every brand here is synthetic (e2e/helpers/brand.ts). Host-forged
// like host-vertical-landing.spec.ts: playwright.config.ts sets MARKETING_HOSTS
// to MARKETING_HOST (plus the suite-only BRAND_E2E_HOST), so no env change is
// needed. The default host is asserted too: the internship product must be
// byte-identical.

const MARKETING = asHost(MARKETING_HOST);
const BLUE_300 = 'rgb(147, 197, 253)';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an unbound marketing host wears the neutral default: coreCRM, blue, the slate core icon set', async ({ page, request }) => {
  await page.setExtraHTTPHeaders(MARKETING);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect(page.locator('header svg[data-default-mark]').first()).toBeVisible();
  await expect(page.locator('header svg.lucide-graduation-cap')).toHaveCount(0);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#1D4ED8');
  await expect(page.locator('link[rel="icon"][href="/icon-core.svg"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"][href="/icon.svg"]')).toHaveCount(0);
  // Safari loads no SVG favicon: without a raster entry it falls through to the
  // implicit /favicon.ico, which is the internship cap.
  await expect(page.locator('link[rel="icon"][href="/icon-core-192.png"]')).toHaveCount(1);
  // iOS launch screens are a separate, per-mark set (lib/appleSplash.ts).
  const splash = page.locator('link[rel="apple-touch-startup-image"]');
  expect(await splash.count()).toBe(17);
  for (const href of await splash.evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href, 'a marketing splash image').toMatch(/-core\.png$/);
  }
  expect((await request.get((await splash.first().getAttribute('href'))!)).status()).toBe(200);

  const m = await (await request.get('/manifest.webmanifest', { headers: MARKETING })).json();
  expect(m.name).toBe('coreCRM');
  expect(m.short_name).toBe('coreCRM');
  expect(m.theme_color).toBe('#1D4ED8');
  const srcs: string[] = m.icons.map((i: { src: string }) => i.src);
  expect(srcs).toEqual(['/icon-core.svg', '/icon-core-192.png', '/icon-core-512.png', '/icon-core-512-maskable.png']);
  for (const src of srcs) expect((await request.get(src)).status(), `${src} should be served`).toBe(200);
  expect((await request.get('/apple-touch-icon-core.png')).status()).toBe(200);
  // The long-press shortcuts sit on the slate tile, not the internship blue one.
  const shortcutSrcs: string[] = m.shortcuts.flatMap((s: { icons: { src: string }[] }) => s.icons.map((i) => i.src));
  expect(shortcutSrcs).toHaveLength(3);
  for (const src of shortcutSrcs) {
    expect(src).toMatch(/-core-96\.png$/);
    expect((await request.get(src)).status(), `${src} should be served`).toBe(200);
  }
});

test('the sign-in page on an unbound marketing host shows the neutral tile, not the cap', async ({ page }) => {
  await page.setExtraHTTPHeaders(MARKETING);
  await page.goto('/auth/signin');
  await expect(page.locator('svg[data-default-mark]').first()).toBeVisible();
  await expect(page.locator('svg.lucide-graduation-cap')).toHaveCount(0);
  await expect(page.locator('img[data-brand-mark]')).toHaveCount(0);
});

test.describe('a marketing host bound to a branded organization', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!!process.env.BASE_URL, 'needs the local server, whose MARKETING_HOSTS includes the suite-only brand host');

  let bound: BoundBrand | null = null;
  test.beforeAll(async ({ playwright, baseURL }) => {
    bound = await bindSyntheticBrand(playwright, baseURL!, BRAND_E2E_HOST);
  });
  test.afterAll(async () => {
    await bound?.release();
  });

  test('wears its database brand: name, tint, palette — never the neutral default', async ({ page, request }) => {
    await page.setExtraHTTPHeaders(asHost(BRAND_E2E_HOST));
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-accent', 'brand');
    expect(await html.getAttribute('style')).toMatch(new RegExp(`--brand-600:\\s*${SYNTHETIC_BRAND.palette[6]}`));
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', SYNTHETIC_BRAND.color);
    await expect(page.locator('meta[name="application-name"]')).toHaveAttribute('content', SYNTHETIC_BRAND.name);
    const m = await (await request.get('/manifest.webmanifest', { headers: asHost(BRAND_E2E_HOST) })).json();
    expect(m.name).toBe(SYNTHETIC_BRAND.name);
    expect(m.theme_color).toBe(SYNTHETIC_BRAND.color);
  });

  // The hero's accent word is `text-blue-600`, which dark mode lightens to the
  // accent's own -300: the palette's on the bound host, blue-300 on an unbound
  // marketing host and on the default host.
  test('dark mode keeps the accent: the palette -300 when bound, blue-300 otherwise', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: 'theme', value: 'dark', url: baseURL! }]);
    const accentWord = page.locator('h1 span.text-blue-600');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(SYNTHETIC_BRAND.palette[3].slice(i, i + 2), 16));

    await page.setExtraHTTPHeaders(asHost(BRAND_E2E_HOST));
    await page.goto('/');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await expect(accentWord).toHaveCSS('color', `rgb(${r}, ${g}, ${b})`);

    await page.setExtraHTTPHeaders(MARKETING);
    await page.goto('/');
    await expect(accentWord).toHaveCSS('color', BLUE_300);

    await page.setExtraHTTPHeaders({});
    await page.goto('/');
    await expect(accentWord).toHaveCSS('color', BLUE_300);
  });
});

// /messages carries its own viewport export (viewportFit: cover), which
// replaces the root one — so its tint has to follow the brand by itself. A
// MARKETING-org account signs in on the marketing host only (#2590: the URL
// decides the product), so the header is set before sign-in and kept for the
// /messages navigation. Signed in, the page wears the person's OWN
// organization's brand — here a synthetic one set straight on the row.
test('signed in to a branded marketing org, /messages keeps its tint and palette', async ({ page }) => {
  const org = await prisma.organization.create({
    data: {
      slug: `mkt-tint-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      name: 'Tint Test Org',
      vertical: 'MARKETING',
      brandName: SYNTHETIC_BRAND.name,
      brandColor: SYNTHETIC_BRAND.color,
      brandAccent: 'brand',
      brandPalette: SYNTHETIC_BRAND.palette.join(','),
    },
  });
  const email = uniqueEmail('mkt-tint');
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
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', SYNTHETIC_BRAND.color);
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'brand');
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
  const email = uniqueEmail('mkt-world');
  const pw = 'WorldPass123';
  await seedUser(email, pw, 'ADMIN', 'World Admin');
  try {
    const login = await signInViaApi(request, email, pw);
    expect(login.ok, `sign-in on the default host: ${login.error}`).toBe(true);
    expect((await apiSession(request))?.user.email).toBe(email);
    expect(await apiSession(request, MARKETING_HOST), 'a session is not valid on the other world\'s host').toBeNull();

    const manifest = await (await request.get('/manifest.webmanifest', { headers: MARKETING })).json();
    expect(manifest.name).toBe('coreCRM');
  } finally {
    await cleanupByEmail(email);
  }
});

test('the default host is unchanged: blue accent, the cap, the internship manifest and icon', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'blue');
  await expect(page.locator('svg[data-default-mark]')).toHaveCount(0);
  await expect(page.locator('header svg.lucide-graduation-cap').first()).toBeVisible();
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#1D4ED8');
  await expect(page.locator('link[rel="icon"][href="/icon.svg"]')).toHaveCount(1);
  const m = await (await request.get('/manifest.webmanifest')).json();
  expect(m.name).toBe('Internship CRM');
  expect(m.theme_color).toBe('#1D4ED8');
  expect((await request.get('/icon.svg')).status()).toBe(200);
  const shortcutSrcs: string[] = m.shortcuts.flatMap((s: { icons: { src: string }[] }) => s.icons.map((i) => i.src));
  for (const src of shortcutSrcs) expect(src).not.toMatch(/-core-/);
  for (const href of await page.locator('link[rel="apple-touch-startup-image"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href).not.toMatch(/-core\.png$/);
  }
});
