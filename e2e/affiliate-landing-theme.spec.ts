import crypto from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { MARKETING_HOST, asHost, signInViaApi } from './helpers/auth';

// The public partner page's own look (docs/affiliate-module.md § The page's
// look, #3535). What this pins:
//   1. uploads: raster images and mp4/webm only, bytes checked against the type,
//      served back from our own route (nosniff, byte ranges for video);
//   2. the theme is validated on save — an external address, a colour without
//      contrast, another org's upload are refused by field — and an unchanged
//      save writes nothing; the audit names the changed parts only;
//   3. /partner and /partner/apply draw the theme (colours, font, uploads);
//      without one the page is the standard page;
//   4. reduced motion: no entrance effect is ever armed.
//
// Serial and host-borrowing like e2e/affiliate-public-page.spec.ts. SYNTHETIC ONLY.

test.describe.configure({ mode: 'serial' });

const PW = 'AffTheme123!';
const host = asHost(MARKETING_HOST);
const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const email = uniqueEmail('aff-theme');
let orgId = '';
let otherOrgId = '';
let previousHolderId: string | null = null;
let admin: APIRequestContext | null = null;

const PLAN = {
  currency: 'EUR',
  tiers: [{ upToMinor: 2_000, commissionMinor: 5_000 }],
  topCommissionMinor: 15_000,
  percentBps: 0,
  switchAtCustomer: null,
  boundaryCustomer: 'PERCENT',
  windowMonths: null,
  payoutDays: 30,
  afterNotice: 'RUN_OUT',
};
const COPY = { en: { heroTitle: 'Acme Sales partner programme', intro: 'Synthetic introduction.', steps: [{ title: 'Apply', text: 'Tell us about you.' }] } };
const THEME = {
  colors: { primary: '#c2410c', secondary: '#6d28d9', heading: '#0b1f4d', text: '#3f3f46', background: '#ffffff', surface: '#f4f4f5' },
  headingFont: 'poppins',
  bodyFont: 'manrope',
  heroHeight: 'tall',
  stepsStyle: 'band',
  ctaStyle: 'plain',
  animation: 'rise',
};

// A 1×1 PNG: real bytes, so the signature check passes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
// An ISO-media header ("ftyp" at offset 4): enough for the signature check; it does not need to play here.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);

const upload = (ctx: APIRequestContext, name: string, mimeType: string, buffer: Buffer) =>
  ctx.post('/api/admin/affiliate/settings/landing/assets', { headers: host, multipart: { file: { name, mimeType, buffer } } });
const putLanding = (ctx: APIRequestContext, landing: unknown) => ctx.put('/api/admin/affiliate/settings/landing', { headers: host, data: { landing } });
const fields = async (res: { json: () => Promise<{ issues?: { field: string; code: string }[] }> }) =>
  ((await res.json()).issues ?? []).map((i) => `${i.field}:${i.code}`).sort();

test.beforeAll(async ({ playwright, baseURL }) => {
  const holder = await prisma.organization.findUnique({ where: { publicHost: MARKETING_HOST }, select: { id: true, slug: true } });
  if (holder && !holder.slug.startsWith('aff-public-') && !holder.slug.startsWith('aff-theme-')) previousHolderId = holder.id;
  if (holder) await prisma.organization.update({ where: { id: holder.id }, data: { publicHost: null } });
  orgId = (await prisma.organization.create({ data: { name: `Acme Sales ${stamp}`, slug: `aff-theme-${stamp}`, vertical: 'MARKETING', publicHost: MARKETING_HOST } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `Beta Sales ${stamp}`, slug: `aff-theme-other-${stamp}`, vertical: 'MARKETING' } })).id;
  await prisma.affiliateProgramSettings.create({ data: { orgId, plan: PLAN, planVersion: 1, planEffectiveAt: new Date(), landing: { copy: COPY } } });
  await seedUser(email, PW, 'ADMIN', 'Theme Admin', { orgId });
  admin = await playwright.request.newContext({ baseURL });
  expect((await signInViaApi(admin, email, PW, { host: MARKETING_HOST })).ok).toBe(true);
});

test.afterAll(async () => {
  await admin?.dispose();
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    await prisma.affiliateLandingAsset.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.affiliateProgramSettings.deleteMany({ where: { orgId: id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { orgId: id } }).catch(() => {});
  }
  await cleanupByEmail(email);
  for (const id of [orgId, otherOrgId].filter(Boolean)) await prisma.organization.deleteMany({ where: { id } }).catch(() => {});
  if (previousHolderId) {
    await prisma.organization
      .update({ where: { id: previousHolderId }, data: { publicHost: MARKETING_HOST } })
      .catch((e) => console.error(`affiliate-landing-theme: could not restore publicHost ${MARKETING_HOST}:`, e));
  }
  await prisma.$disconnect();
});

test('without a theme the page is the standard page', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ ...host, 'accept-language': 'en' });
  expect((await page.goto('/partner'))?.status()).toBe(200);
  await expect(page.getByTestId('partner-page')).not.toHaveAttribute('data-theme', /.+/);
});

let logoId = '';
let heroId = '';
let videoId = '';

test('uploads: our own storage, checked bytes, served with nosniff and byte ranges', async ({ request }) => {
  const ctx = admin as APIRequestContext;
  const logo = await upload(ctx, 'logo.png', 'image/png', PNG);
  expect(logo.status()).toBe(201);
  logoId = (await logo.json()).id;
  heroId = (await (await upload(ctx, 'hero.png', 'image/png', PNG)).json()).id;
  const video = await upload(ctx, 'loop.mp4', 'video/mp4', MP4);
  expect(await video.json()).toMatchObject({ kind: 'video', url: expect.stringMatching(/^\/api\/public\/partner-media\/[a-z0-9]+$/) });
  videoId = (await video.json()).id;

  // No SVG (script), no renamed file, nothing over the limit for its kind.
  expect(await (await upload(ctx, 'x.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).json()).toEqual({ code: 'unsupported' });
  expect(await (await upload(ctx, 'x.png', 'image/png', Buffer.from('<html>not a png</html>'))).json()).toEqual({ code: 'mismatch' });
  expect((await upload(ctx, 'big.png', 'image/png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))).status()).toBe(400);
  // Signed out, no upload at all.
  expect((await request.post('/api/admin/affiliate/settings/landing/assets', { headers: host, multipart: { file: { name: 'l.png', mimeType: 'image/png', buffer: PNG } } })).status()).toBeGreaterThanOrEqual(401);

  const served = await request.get(`/api/public/partner-media/${logoId}`);
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toBe('image/png');
  expect(served.headers()['x-content-type-options']).toBe('nosniff');
  expect(Buffer.from(await served.body()).equals(PNG)).toBe(true);
  const ranged = await request.get(`/api/public/partner-media/${videoId}`, { headers: { range: 'bytes=4-11' } });
  expect(ranged.status()).toBe(206);
  expect(Buffer.from(await ranged.body()).toString()).toBe('ftypisom');
  expect(ranged.headers()['content-range']).toBe(`bytes 4-11/${MP4.length}`);
  expect((await request.get('/api/public/partner-media/nope')).status()).toBe(404);
});

test('a theme is validated by field, saved once, and audited by part', async () => {
  const ctx = admin as APIRequestContext;
  const bad = await putLanding(ctx, { copy: COPY, theme: { ...THEME, colors: { ...THEME.colors, text: '#d4d4d8' }, bodyFont: 'https://fonts.example/x.css' } });
  expect(bad.status()).toBe(400);
  expect(await fields(bad)).toEqual(['theme.bodyFont:invalid']);
  expect(await fields(await putLanding(ctx, { copy: COPY, theme: { ...THEME, colors: { ...THEME.colors, text: '#d4d4d8' } } }))).toEqual([
    'theme.colors.surface:contrast',
    'theme.colors.text:contrast',
  ]);
  expect(await fields(await putLanding(ctx, { copy: COPY, theme: { ...THEME, media: { hero: 'https://cdn.example/hero.jpg' } } }))).toEqual(['theme.media.hero:invalid']);
  // A video is not a logo, and another organisation's upload is not ours.
  const foreign = (await prisma.affiliateLandingAsset.create({ data: { orgId: otherOrgId, kind: 'image', contentType: 'image/png', size: PNG.length, data: PNG } })).id;
  expect(await fields(await putLanding(ctx, { copy: COPY, theme: { ...THEME, media: { logo: videoId, hero: foreign } } }))).toEqual([
    'theme.media.hero:invalid',
    'theme.media.logo:invalid',
  ]);
  expect(await prisma.auditLog.count({ where: { orgId, action: 'affiliate.landing.update' } })).toBe(0);

  const theme = { ...THEME, media: { logo: logoId, hero: heroId, showcase: videoId } };
  const saved = await putLanding(ctx, { copy: COPY, theme });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).changed).toBe(true);
  // The same theme in another key order, colours in upper case: no change, no audit row.
  const { colors, ...rest } = THEME;
  const reordered = { media: theme.media, colors: Object.fromEntries(Object.entries(colors).reverse().map(([k, v]) => [k, v.toUpperCase()])), ...rest };
  expect((await (await putLanding(ctx, { theme: reordered, copy: COPY })).json()).changed).toBe(false);
  const rows = await prisma.auditLog.findMany({ where: { orgId, action: 'affiliate.landing.update' }, select: { detail: true } });
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].detail as string)).toEqual({ changed: ['theme'] });
  expect(rows[0].detail).not.toContain('#');
});

test('the page and the application form draw the theme', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ ...host, 'accept-language': 'en' });
  expect((await page.goto('/partner'))?.status()).toBe(200);
  const root = page.getByTestId('partner-page');
  await expect(root).toHaveAttribute('data-theme', 'custom');
  await expect(root).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.getByTestId('partner-logo')).toHaveAttribute('src', `/api/public/partner-media/${logoId}`);
  await expect(page.getByTestId('partner-hero-image')).toHaveAttribute('src', `/api/public/partner-media/${heroId}`);
  await expect(page.getByTestId('partner-showcase').locator('video')).toHaveAttribute('src', `/api/public/partner-media/${videoId}`);
  await expect(page.getByTestId('partner-theme-video-toggle')).toBeVisible();
  // Poppins for headings (self-hosted by next/font: the family name is next/font's own).
  expect(await page.getByRole('heading', { level: 1 }).evaluate((h) => getComputedStyle(h).fontFamily)).toMatch(/Poppins/);
  // The table's button in the main colour; its text white (large text, 3:1).
  const cta = page.getByTestId('partner-cta-apply');
  await expect(cta).toHaveCSS('background-color', 'rgb(194, 65, 12)');
  await expect(cta).toHaveCSS('color', 'rgb(255, 255, 255)');
  // The steps sit on a band in the heading colour.
  await expect(page.getByTestId('partner-steps')).toHaveCSS('background-color', 'rgb(11, 31, 77)');
  // Every door of the standard page is still there.
  await expect(page.getByTestId('partner-apply')).toHaveAttribute('href', '/partner/apply');
  await expect(page.getByTestId('partner-portal')).toHaveAttribute('href', /\/auth\/signin\?callbackUrl=%2Faffiliate$/);

  expect((await page.goto('/partner/apply'))?.status()).toBe(200);
  await expect(page.getByTestId('partner-logo')).toHaveAttribute('src', `/api/public/partner-media/${logoId}`);
  await expect(page.getByTestId('affiliate-apply-submit')).toHaveCSS('background-color', 'rgb(194, 65, 12)');
});

test('the entrance effect: armed with motion, never under reduced motion', async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ ...host, 'accept-language': 'en' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/partner');
  await expect(page.locator('.pt-reveal[data-armed]').first()).toBeAttached();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/partner');
  await expect(page.locator('.pt-reveal').first()).toBeAttached();
  // Give hydration its chance to arm anything, then: nothing is, and nothing is hidden.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.pt-reveal[data-armed]')).toHaveCount(0);
  await expect(page.getByTestId('partner-theme-video')).toHaveAttribute('data-playing', 'false');
});
