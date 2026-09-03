import { test, expect } from '@playwright/test';

test('web app manifest is served and installable-shaped', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBe('Internship CRM');
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBe('/');
  expect(Array.isArray(m.icons) && m.icons.length).toBeGreaterThan(0);
});

test('the manifest carries identity, shortcuts and a share target', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  const m = await res.json();

  expect(m.id).toBe('/');
  expect(m.lang).toBe('en');
  expect(m.dir).toBe('ltr');
  expect(m.display_override).toContain('minimal-ui');
  expect(m.categories).toContain('business');
  // Not portrait-locked: the pipeline board is a wide horizontal scroller.
  expect(m.orientation).not.toBe('portrait-primary');

  expect(m.shortcuts).toHaveLength(3);
  expect(m.shortcuts.map((s: { url: string }) => s.url)).toEqual(['/messages', '/todos', '/notifications']);

  expect(m.share_target.action).toBe('/share');
  expect(m.share_target.method).toBe('GET');
  expect(m.share_target.params).toMatchObject({ title: 'title', text: 'text', url: 'url' });
});

test('every asset the manifest names is actually served', async ({ request }) => {
  const m = await (await request.get('/manifest.webmanifest')).json();
  const icons: string[] = [
    ...m.icons.map((i: { src: string }) => i.src),
    ...m.shortcuts.flatMap((s: { icons?: { src: string }[] }) => (s.icons ?? []).map((i) => i.src)),
    ...(m.screenshots ?? []).map((s: { src: string }) => s.src),
  ];
  for (const src of icons) {
    const res = await request.get(src);
    expect(res.status(), `${src} should be served`).toBe(200);
  }
});

test('iOS launch screens are linked and served', async ({ page, request }) => {
  await page.goto('/');
  const links = page.locator('link[rel="apple-touch-startup-image"]');
  const count = await links.count();
  expect(count).toBeGreaterThan(10);
  const href = await links.first().getAttribute('href');
  expect(href).toBeTruthy();
  expect(await links.first().getAttribute('media')).toContain('device-width');
  expect((await request.get(href as string)).status()).toBe(200);
});

test('a shortcut tap while signed out returns to the shortcut target', async ({ page }) => {
  await page.goto('/todos');
  await expect(page).toHaveURL(/\/auth\/signin\?callbackUrl=%2Ftodos|\/auth\/signin\?callbackUrl=\/todos/);
});

test('the share target only offers to save what was shared', async ({ page }) => {
  await page.goto('/share?title=Hello&url=https%3A%2F%2Fexample.com%2Fa');
  // Signed out, the shared payload survives the sign-in redirect.
  await expect(page).toHaveURL(/\/auth\/signin\?callbackUrl=/);
  expect(decodeURIComponent(page.url())).toContain('/share?title=Hello');
});

test('the service worker script is served', async ({ request }) => {
  const res = await request.get('/sw.js');
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['content-type']).toContain('javascript');
});

test('the home page links the manifest', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});
