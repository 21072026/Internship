import { test, expect, Page } from '@playwright/test';

/**
 * Smoke tests — fast quality gate. Verify the app boots, auth works, and the
 * core admin pages render without server errors or console errors.
 *
 * Credentials come from the seeded admin (CI seeds these; preview uses the same).
 */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

function attachDiagnostics(page: Page, sink: string[]) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') sink.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (err) => sink.push(`[pageerror] ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 500) sink.push(`[HTTP ${res.status()}] ${res.url()}`);
  });
}

async function login(page: Page) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
}

test('home page loads with favicon and no console errors', { tag: '@smoke' }, async ({ page }) => {
  const diag: string[] = [];
  attachDiagnostics(page, diag);
  const res = await page.goto('/');
  expect(res?.status() ?? 0).toBeLessThan(400);
  await page.waitForTimeout(800);
  const iconHref = await page.locator('link[rel="icon"]').first().getAttribute('href').catch(() => null);
  expect(iconHref, 'an <link rel="icon"> should be present').toBeTruthy();
  expect(diag, `unexpected diagnostics: ${diag.join(' | ')}`).toEqual([]);
});

test('signin page renders the credentials form', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/auth/signin');
  await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeVisible();
});

test('admin can log in and lands off the signin page', { tag: '@smoke' }, async ({ page }) => {
  await login(page);
  expect(page.url()).not.toContain('/auth/signin');
});

test('admin pages load without server errors', { tag: '@smoke' }, async ({ page }) => {
  await login(page);
  const paths = ['/admin', '/admin/candidates', '/admin/mentorship', '/admin/companies', '/admin/invite'];
  for (const path of paths) {
    const diag: string[] = [];
    attachDiagnostics(page, diag);
    const res = await page.goto(path);
    await page.waitForTimeout(700);
    const status = res?.status() ?? 0;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    const looksError = /application error|something went wrong|internal server error|unhandled/i.test(bodyText);
    expect(status, `${path} HTTP status`).toBeLessThan(400);
    expect(looksError, `${path} shows an error page`).toBeFalsy();
    expect(diag, `${path} diagnostics: ${diag.join(' | ')}`).toEqual([]);
  }
});
