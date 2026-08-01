import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { totp } from '../src/lib/totp';
import { submitSignInForm } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Submits without waiting for a landing page: once 2FA is on, the expected
// outcome is staying on /auth/signin with the authenticator field.
const fillLogin = submitSignInForm;

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
    const used = totp(setup.secret);
    await codeField.fill(used);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // #865: that code is spent. Three codes are valid at any moment (±1 step
    // for clock skew), so without recording the consumed step a shoulder-surfed
    // code could be replayed for the next ~90 seconds.
    await fillLogin(page, email, 'UserPass123');
    const replayField = page.getByLabel('Authenticator code');
    await expect(replayField).toBeVisible({ timeout: 10_000 });
    await replayField.fill(used);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/auth\/signin/);
    await expect(page.getByText(/Invalid authenticator code|Too many attempts/i)).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});

/**
 * #865: `clearRateLimit(failKey)` ran as soon as the *password* verified, so
 * the 6-digit code that followed had no limiter behind it at all — the whole
 * 10^6 space was guessable as fast as the server would answer. Failed codes now
 * have their own bucket (5 per 15 min).
 */
test('failed authenticator codes are rate limited', async ({ page }) => {
  const email = uniqueEmail('tfa-brute');
  await seedUser(email, 'BrutePass123', 'MENTEE', 'TFA Brute');

  try {
    await fillLogin(page, email, 'BrutePass123');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
    const setup = await (await page.request.post('/api/account/2fa', { data: { action: 'setup' } })).json();
    await page.request.post('/api/account/2fa', { data: { action: 'enable', code: totp(setup.secret) } });

    // Six wrong codes: the sixth must be refused by the limiter, not the check.
    for (let i = 0; i < 6; i++) {
      await fillLogin(page, email, 'BrutePass123');
      const field = page.getByLabel('Authenticator code');
      await expect(field).toBeVisible({ timeout: 10_000 });
      await field.fill(String(100000 + i));
      await page.click('button[type="submit"]');
      await expect(page.getByText(/Invalid authenticator code|Too many attempts/i)).toBeVisible({ timeout: 10_000 });
    }
    await expect(page.getByText(/Too many attempts/i)).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
