import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { totp } from '../src/lib/totp';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function fillLogin(page: import('@playwright/test').Page, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

test('a user enables TOTP 2FA and must provide a code at sign-in', async ({ page }) => {
  const email = uniqueEmail('tfa-user');
  await seedUser(email, 'UserPass123', 'MENTEE', 'TFA User');

  try {
    // Sign in and enable 2FA via the account API.
    await fillLogin(page, email, 'UserPass123');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const setup = await (await page.request.post('/api/account/2fa', { data: { action: 'setup' } })).json();
    expect(setup.secret).toBeTruthy();
    const enable = await page.request.post('/api/account/2fa', { data: { action: 'enable', code: totp(setup.secret) } });
    expect(enable.ok()).toBeTruthy();

    // Password alone no longer logs in — the 2FA field appears.
    await fillLogin(page, email, 'UserPass123');
    const codeField = page.getByLabel('Authenticator code');
    await expect(codeField).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/auth\/signin/);

    // Providing a valid code completes sign-in.
    await codeField.fill(totp(setup.secret));
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
