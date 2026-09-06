import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * Route-level error boundaries (#1602).
 *
 * `/mentor/e2e-error` and `/portal/e2e-error` throw on the server on purpose —
 * they exist only for this spec and are a 404 unless `E2E_ERROR_ROUTES=1`,
 * which `playwright.config.ts` sets for the local/CI web server and nothing
 * else sets anywhere. So against a deployed target (BASE_URL) there is nothing
 * to force and the spec skips rather than reporting a false red.
 */
test.skip(!!process.env.BASE_URL, 'the forced-throw routes are only enabled on the local/CI web server');

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a server error under /mentor renders the boundary, not Next\'s default screen', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('boundary-mentor');
  const password = 'BoundaryPass123!';
  await seedUser(email, password, 'MENTOR', 'Boundary Mentor');

  try {
    await signInAndSettle(page, email, password, '/mentor');

    await page.goto('/mentor/e2e-error');

    const boundary = page.getByTestId('route-error-boundary');
    await expect(boundary).toBeVisible({ timeout: 20_000 });
    await expect(boundary).toContainText('Something went wrong');

    // The message and the stack must never reach the screen — only the digest.
    await expect(boundary).not.toContainText('Forced mentor error');

    // Retry re-runs the segment, which throws again, so the boundary stays up.
    // What is being asserted is that the control is wired to reset() at all.
    await page.getByTestId('route-error-retry').click();
    await expect(boundary).toBeVisible();

    // The way out goes to the MENTOR landing page, not /admin.
    await page.getByTestId('route-error-home').click();
    await page.waitForURL((u) => u.pathname === '/mentor', { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
  }
});

test('the boundary is translated — Turkish under the locale cookie', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('boundary-tr');
  const password = 'BoundaryPass123!';
  await seedUser(email, password, 'MENTOR', 'Boundary TR Mentor');

  try {
    await signInAndSettle(page, email, password, '/mentor');
    await page.evaluate(() => {
      document.cookie = 'locale=tr;path=/';
    });

    await page.goto('/mentor/e2e-error');

    const boundary = page.getByTestId('route-error-boundary');
    await expect(boundary).toBeVisible({ timeout: 20_000 });
    await expect(boundary).toContainText('Bir şeyler ters gitti');
    await expect(page.getByTestId('route-error-retry')).toHaveText('Tekrar dene');
  } finally {
    await cleanupByEmail(email);
  }
});

test('a server error under /portal sends the mentee back to /portal', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('boundary-mentee');
  const password = 'BoundaryPass123!';
  await seedUser(email, password, 'MENTEE', 'Boundary Mentee');

  try {
    await signInAndSettle(page, email, password, '/portal');

    await page.goto('/portal/e2e-error');

    const boundary = page.getByTestId('route-error-boundary');
    await expect(boundary).toBeVisible({ timeout: 20_000 });
    await expect(boundary).toContainText('Something went wrong');
    await expect(boundary).not.toContainText('Forced portal error');

    // A mentee handed a link to /admin would just bounce off a 403.
    await page.getByTestId('route-error-home').click();
    await page.waitForURL((u) => u.pathname === '/portal', { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
