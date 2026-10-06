import { test, expect } from '@playwright/test';
import { cleanupMenteeWithRelation, seedMenteeWithRelation, type SeededRelation } from './helpers/db';
import { gotoSettled, signInViaApi } from './helpers/auth';

// The site inside the native app (#2775). The app's web view adds
// `InternCRMApp/1` to its User-Agent; the server then renders
// <html data-embedded-app> and the site drops its own top bar and drawer (the
// app draws those natively) — a browser, which never sends the marker, sees no
// change at all. The app's menu comes from
// GET /api/app/navigation, the same sidebar list the web renders.

const PASSWORD = 'AppShell123!';
let seeded: SeededRelation;

test.beforeAll(async () => {
  seeded = await seedMenteeWithRelation('app-shell', PASSWORD);
});
test.afterAll(async () => {
  if (seeded) await cleanupMenteeWithRelation(seeded);
});

test.use({ viewport: { width: 390, height: 844 } });

test('inside the app the site hides its own top bar and drawer', async ({ browser }, info) => {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36 InternCRMApp/1',
  });
  const page = await context.newPage();
  expect((await signInViaApi(page.context().request, seeded.menteeEmail, PASSWORD)).ok).toBe(true);
  await gotoSettled(page, '/portal');
  await expect(page.locator('html')).toHaveAttribute('data-embedded-app', '');
  await expect(page.getByTestId('app-drawer')).toBeHidden();
  await expect(page.locator('[data-app-chrome]').first()).toBeHidden();
  // The page itself still renders.
  await expect(page.locator('main, #main-content').first()).toBeVisible();
  await context.close();
});

test('in a browser nothing changes: the mobile menu button is there', async ({ page }) => {
  expect((await signInViaApi(page.context().request, seeded.menteeEmail, PASSWORD)).ok).toBe(true);
  await gotoSettled(page, '/portal');
  expect(await page.locator('html').getAttribute('data-embedded-app')).toBeNull();
  await expect(page.locator('[data-app-chrome]').first()).toBeVisible();
});

test('GET /api/app/navigation is the role sidebar, and needs a session', async ({ page, playwright }, info) => {
  const anon = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  expect((await anon.get('/api/app/navigation')).status()).toBe(401);
  await anon.dispose();

  const request = page.context().request;
  expect((await signInViaApi(request, seeded.menteeEmail, PASSWORD)).ok).toBe(true);
  const res = await request.get('/api/app/navigation', { headers: { 'Accept-Language': 'en' } });
  expect(res.ok()).toBe(true);
  const { items } = (await res.json()) as { items: { key: string; href: string; label: string }[] };
  const dashboard = items.find((i) => i.href === '/portal');
  expect(dashboard?.key).toBe('dashboard');
  expect(dashboard?.label).toBeTruthy();
  expect(items.some((i) => i.href.startsWith('/admin'))).toBe(false);
});
