import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { asHost, signInViaApi } from './helpers/auth';
import { BRAND_E2E_HOST } from './helpers/hosts';

/**
 * Per-organization brand, resolved from the host (#2922, docs/white-label.md).
 *
 * A MARKETING organization is mapped to the suite's own marketing host
 * (BRAND_E2E_HOST — never the shared one, whose mapping other specs own) and
 * given a brand through the real admin API: a name, a colour, a tile colour,
 * "Organization colour" as the default accent, and an uploaded SVG mark. An
 * anonymous visitor on that host must then get the organization's name, tint,
 * accent palette and GENERATED icon set — in the manifest and in the <head> —
 * with every icon URL answering 200 image/png and the uploaded original never
 * reachable. The default host's manifest is pinned byte for byte: the whole
 * point of this change is that a host without a branded organization is
 * exactly what it was.
 *
 * Everything here is synthetic: "Acme Sales", a teal, a slate tile and a
 * circle-and-square mark.
 */

test.describe.configure({ mode: 'serial' });
test.skip(!!process.env.BASE_URL, 'needs the local server, whose MARKETING_HOSTS includes the suite-only brand host');

const HOST = BRAND_E2E_HOST;
const BRAND_NAME = 'Acme Sales';
const BRAND_COLOR = '#0e7490';
const TILE_COLOR = '#1e293b';
const MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#fde047"/><rect x="18" y="18" width="12" height="12" fill="#111827"/></svg>';
const PASSWORD = 'HostBrandPass123';

// What the default host's manifest has always been (src/app/manifest.ts). A
// literal on purpose: a change to it is a change to every installed app.
const INTERNSHIP_MANIFEST = {
  id: '/',
  name: 'Internship CRM',
  short_name: 'InternshipCRM',
  description: 'Mentor ↔ mentee CRM & internship pipeline',
  lang: 'en',
  dir: 'ltr',
  categories: ['business', 'productivity', 'education'],
  start_url: '/',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  background_color: '#ffffff',
  theme_color: '#1D4ED8',
  orientation: 'any',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    { name: 'Messages', short_name: 'Messages', description: 'Open your conversations', url: '/messages', icons: [{ src: '/shortcut-messages-96.png', sizes: '96x96', type: 'image/png' }] },
    { name: 'To-dos', short_name: 'To-dos', description: 'Everything on your list', url: '/todos', icons: [{ src: '/shortcut-todos-96.png', sizes: '96x96', type: 'image/png' }] },
    { name: 'Notifications', short_name: 'Alerts', description: 'What happened while you were away', url: '/notifications', icons: [{ src: '/shortcut-notifications-96.png', sizes: '96x96', type: 'image/png' }] },
  ],
  share_target: { action: '/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
};

const adminEmail = uniqueEmail('host-brand-admin');
let orgId = '';
let version = '';

test.beforeAll(async () => {
  // A crashed earlier run may have left the host mapped: the column is unique.
  await prisma.organization.updateMany({ where: { publicHost: HOST }, data: { publicHost: null } });
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({
    data: { name: `Host Brand ${stamp}`, slug: `host-brand-${stamp}`, vertical: 'MARKETING', plan: 'ENTERPRISE', publicHost: HOST },
  });
  orgId = org.id;
  await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Host Brand Admin', { orgId });
});

test.afterAll(async () => {
  await prisma.organization.updateMany({ where: { id: orgId }, data: { publicHost: null } }).catch(() => {});
  await cleanupByEmail(adminEmail);
  // BrandAsset rows go with the organization (onDelete: Cascade).
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  await prisma.$disconnect();
});

test('a host mapped to a branded organization wears its brand: manifest, head, accent and generated icons', { tag: '@smoke' }, async ({ page, request, playwright, baseURL }) => {
  // The organization's own ADMIN sets the brand through the real API, on the
  // host its account lives on (a MARKETING account signs in on a marketing host).
  const login = await signInViaApi(request, adminEmail, PASSWORD, { host: HOST });
  expect(login.ok, `sign-in on the brand host: ${login.error}`).toBe(true);
  const patch = await request.patch('/api/admin/organizations', {
    headers: asHost(HOST),
    data: { id: orgId, brandName: BRAND_NAME, brandColor: BRAND_COLOR, brandTileColor: TILE_COLOR, brandAccent: 'brand' },
  });
  expect(patch.status(), await patch.text()).toBe(200);
  // The exact palette is the operator's: a tenant ADMIN may not write one.
  const palette = await request.patch('/api/admin/organizations', {
    headers: asHost(HOST),
    data: { id: orgId, brandPalette: '#ecfeff,#cffafe,#a5f3fc,#67e8f9,#22d3ee,#06b6d4,#0e7490,#155e75,#164e63,#083344' },
  });
  expect(palette.status()).toBe(403);
  expect((await palette.json()).code).toBe('palette_super_admin_only');
  // A hostile SVG never reaches the rasterizer.
  const hostile = await request.post(`/api/admin/organizations/${orgId}/brand-mark`, {
    headers: asHost(HOST),
    multipart: {
      file: {
        name: 'mark.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><image href="file:///etc/passwd" width="48" height="48"/></svg>'),
      },
    },
  });
  expect(hostile.status()).toBe(400);
  expect(await hostile.json()).toMatchObject({ code: 'mark_refused', reason: 'forbidden_element' });
  const upload = await request.post(`/api/admin/organizations/${orgId}/brand-mark`, {
    headers: asHost(HOST),
    multipart: { file: { name: 'mark.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(MARK_SVG) } },
  });
  expect(upload.status(), await upload.text()).toBe(200);
  version = (await upload.json()).version;
  expect(version).toMatch(/^[0-9a-f]{16}$/);
  const base = `/brand/${version}/`;

  // ── Fetched without cookies: the manifest and the icon files. ──
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(HOST) });
  try {
    const m = await (await anon.get('/manifest.webmanifest')).json();
    expect(m.name).toBe(BRAND_NAME);
    expect(m.short_name).toBe(BRAND_NAME);
    expect(m.theme_color).toBe(BRAND_COLOR);
    expect(m.id).toBe('/');
    const srcs: string[] = [
      ...m.icons.map((i: { src: string }) => i.src),
      ...m.shortcuts.flatMap((s: { icons: { src: string }[] }) => s.icons.map((i) => i.src)),
    ];
    expect(srcs).toHaveLength(6);
    for (const src of srcs) {
      expect(src.startsWith(base), src).toBe(true);
      const res = await anon.get(src);
      expect(res.status(), src).toBe(200);
      expect(res.headers()['content-type']).toBe('image/png');
      expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers()['x-content-type-options']).toBe('nosniff');
    }
    expect(m.icons.find((i: { purpose: string }) => i.purpose === 'maskable')?.src).toBe(`${base}icon-512-maskable.png`);

    // The uploaded original is stored, never served — under any spelling.
    for (const file of ['source.png', 'source', 'source.svg', 'mark.svg', 'icon-192.svg']) {
      expect((await anon.get(`${base}${file}`)).status(), file).toBe(404);
    }
    // A version that names no set is a 404, not an error.
    expect((await anon.get('/brand/ffffffffffffffff/icon-192.png')).status()).toBe(404);
  } finally {
    await anon.dispose();
  }

  // ── The page an anonymous visitor gets on that host. ──
  await page.setExtraHTTPHeaders(asHost(HOST));
  await page.goto('/auth/signin');
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-accent', 'brand');
  expect(await html.getAttribute('style')).toMatch(/--brand-600:\s*#[0-9a-f]{6}/);
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', BRAND_COLOR);
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute('content', BRAND_NAME);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', BRAND_NAME);
  for (const href of await page.locator('link[rel="icon"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href?.startsWith(base), `icon ${href}`).toBe(true);
  }
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', `${base}apple-touch-icon.png`);
  const splash = await page.locator('link[rel="apple-touch-startup-image"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(splash).toHaveLength(17);
  for (const href of splash) expect(href, 'a launch image').toMatch(new RegExp(`^${base}splash-\\d+x\\d+\\.png$`));
  expect((await page.request.get(splash[0]!)).status()).toBe(200);
  // The sign-in tile carries the generated mark on the tile colour.
  const mark = page.locator('img[data-brand-mark]').first();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('src', `${base}mark-128.png`);
});

test('every signed-out auth page on that host wears the mark: register, forgot, reset (#1663)', async ({ page }) => {
  test.skip(!version, 'needs the brand set by the previous test');
  await page.setExtraHTTPHeaders(asHost(HOST));
  for (const path of ['/auth/register', '/auth/forgot', '/auth/reset?token=unknown']) {
    await page.goto(path);
    const mark = page.locator('img[data-brand-mark]').first();
    await expect(mark, path).toBeVisible();
    await expect(mark, path).toHaveAttribute('src', `/brand/${version}/mark-128.png`);
  }
});

test('removing the mark falls back to the vertical\'s static icons and keeps the name and tint', async ({ request, playwright, baseURL }) => {
  test.skip(!version, 'needs the brand set by the previous test');
  const login = await signInViaApi(request, adminEmail, PASSWORD, { host: HOST });
  expect(login.ok).toBe(true);
  const del = await request.delete(`/api/admin/organizations/${orgId}/brand-mark`, { headers: asHost(HOST) });
  expect(del.status()).toBe(200);

  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: asHost(HOST) });
  try {
    // The old set is gone at once — a version's URLs die with it.
    expect((await anon.get(`/brand/${version}/icon-192.png`)).status()).toBe(404);
    const m = await (await anon.get('/manifest.webmanifest')).json();
    // Still the organization's name and tint (those fields are still set) …
    expect(m.name).toBe(BRAND_NAME);
    expect(m.theme_color).toBe(BRAND_COLOR);
    // … on the vertical's static icon files, every one of them served.
    for (const i of m.icons as { src: string }[]) {
      expect(i.src.startsWith('/brand/'), i.src).toBe(false);
      expect((await anon.get(i.src)).status(), i.src).toBe(200);
    }
  } finally {
    await anon.dispose();
  }
});

test('the default host is untouched: the internship manifest byte for byte, no organization icons', async ({ request, page }) => {
  expect(await (await request.get('/manifest.webmanifest')).json()).toEqual(INTERNSHIP_MANIFEST);
  await page.goto('/auth/signin');
  await expect(page.locator('html')).not.toHaveAttribute('data-accent', 'brand');
  expect(await page.locator('html').getAttribute('style')).toBeNull();
  await expect(page.locator('img[data-brand-mark]')).toHaveCount(0);
  for (const href of await page.locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="apple-touch-startup-image"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))) {
    expect(href?.startsWith('/brand/'), String(href)).toBe(false);
  }
});
