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

test('the service worker script is served', async ({ request }) => {
  const res = await request.get('/sw.js');
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['content-type']).toContain('javascript');
});

test('the home page links the manifest', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});
