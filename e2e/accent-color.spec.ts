import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('a user can pick an accent color; it applies live and persists across reloads', async ({ page }) => {
  const email = uniqueEmail('accent');
  const pw = 'AccentPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Accent Mentee');

  try {
    await signIn(page, email, pw, '/portal');
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible({ timeout: 10_000 });

    const html = page.locator('html');
    // Test build isn't the preview env, so the default accent is blue.
    await expect(html).toHaveAttribute('data-accent', 'blue');

    // Pick "Purple" — the swatch is a radio labelled by its color name.
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/profile') && r.request().method() === 'PUT',
      { timeout: 20_000 }
    );
    await page.getByRole('radio', { name: 'Purple' }).click();
    const res = await done;
    expect(res.ok()).toBeTruthy();

    // Applies instantly, without a reload.
    await expect(html).toHaveAttribute('data-accent', 'purple');

    // Persisted to the account.
    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: user.id } }))?.accentColor, { timeout: 10_000 })
      .toBe('purple');

    // And survives a full reload (SSR reads the cookie / saved preference).
    await page.reload();
    await expect(html).toHaveAttribute('data-accent', 'purple');
  } finally {
    await cleanupByEmail(email);
  }
});
