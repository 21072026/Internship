import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { totp } from '../src/lib/totp';
import { submitSignInForm } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * 2FA recovery codes (#1542).
 *
 * The feature exists for one scenario the product could not survive: 2FA is on,
 * the phone is gone, and there is no way back in. So the assertions here are
 * the promises, not the plumbing — a code signs you in, the same code never
 * works twice, the plaintext is nowhere in the database, and a spent set is
 * visible and replaceable.
 */
test('a recovery code signs the user in exactly once', async ({ page }) => {
  const email = uniqueEmail('tfa-recovery');
  await seedUser(email, 'RecoverPass123', 'MENTEE', 'Recovery User');

  try {
    await submitSignInForm(page, email, 'RecoverPass123');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Enrolment hands back the set, once.
    const setup = await (await page.request.post('/api/account/2fa', { data: { action: 'setup' } })).json();
    const enableRes = await page.request.post('/api/account/2fa', {
      data: { action: 'enable', code: totp(setup.secret) },
    });
    expect(enableRes.ok()).toBeTruthy();
    const enabled = await enableRes.json();
    expect(Array.isArray(enabled.recoveryCodes)).toBeTruthy();
    expect(enabled.recoveryCodes).toHaveLength(10);
    const codes: string[] = enabled.recoveryCodes;

    // Hashed at rest: not one stored value contains a code, in any spelling.
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    const stored = await prisma.twoFactorRecoveryCode.findMany({
      where: { userId: user!.id },
      select: { codeHash: true, usedAt: true },
    });
    expect(stored).toHaveLength(10);
    for (const row of stored) {
      expect(row.usedAt).toBeNull();
      for (const code of codes) {
        expect(row.codeHash).not.toContain(code);
        expect(row.codeHash).not.toContain(code.replace('-', ''));
      }
    }

    // A later read gives counts, never codes.
    const status = await (await page.request.get('/api/account/2fa')).json();
    expect(status.enabled).toBe(true);
    expect(status.recoveryCodes).toEqual(
      expect.objectContaining({ total: 10, remaining: 10 }),
    );
    expect(JSON.stringify(status)).not.toContain(codes[0]);

    // The authenticator is "lost": password alone stops at the code field, and
    // a recovery code — typed in the same field, dash and all — gets in.
    await submitSignInForm(page, email, 'RecoverPass123');
    const codeField = page.getByLabel('Authenticator code');
    await expect(codeField).toBeVisible({ timeout: 10_000 });
    await codeField.fill(codes[0]);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Spent: the same code is refused on a second attempt.
    await submitSignInForm(page, email, 'RecoverPass123');
    const reuseField = page.getByLabel('Authenticator code');
    await expect(reuseField).toBeVisible({ timeout: 10_000 });
    await reuseField.fill(codes[0]);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/auth\/signin/);
    await expect(page.getByText(/Invalid authenticator code|Too many attempts/i)).toBeVisible({
      timeout: 10_000,
    });

    // A *different* code from the same set still works — one code was spent,
    // not the set.
    const second = page.getByLabel('Authenticator code');
    await second.fill(codes[1]);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const after = await (await page.request.get('/api/account/2fa')).json();
    expect(after.recoveryCodes.remaining).toBe(8);
    expect(after.recoveryCodes.total).toBe(10);

    // Regeneration replaces the whole set: a fresh ten, and the old codes are
    // dead even though they were never used.
    const regen = await page.request.post('/api/account/2fa', { data: { action: 'regenerate-codes' } });
    expect(regen.ok()).toBeTruthy();
    const fresh: string[] = (await regen.json()).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(codes[2]);

    await submitSignInForm(page, email, 'RecoverPass123');
    const staleField = page.getByLabel('Authenticator code');
    await expect(staleField).toBeVisible({ timeout: 10_000 });
    await staleField.fill(codes[2]);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/auth\/signin/);
    await expect(page.getByText(/Invalid authenticator code|Too many attempts/i)).toBeVisible({
      timeout: 10_000,
    });

    // …and one from the new set does work.
    await staleField.fill(fresh[0]);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
  }
});

/**
 * The remaining count and the regenerate button are the only way a user learns
 * that their set is running low — the codes themselves are gone after
 * enrolment, so a card that showed nothing would leave them to find out on the
 * day it matters.
 */
test('account settings shows the remaining count and can replace the set', async ({ page }) => {
  const email = uniqueEmail('tfa-recovery-ui');
  await seedUser(email, 'RecoverPass123', 'MENTEE', 'Recovery UI');

  try {
    await submitSignInForm(page, email, 'RecoverPass123');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    const setup = await (await page.request.post('/api/account/2fa', { data: { action: 'setup' } })).json();
    await page.request.post('/api/account/2fa', { data: { action: 'enable', code: totp(setup.secret) } });

    await page.goto('/account');
    const section = page.getByTestId('recovery-codes-section');
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('recovery-codes-remaining')).toContainText('10 / 10');
    // Nothing on a reloaded page may carry a code.
    await expect(page.getByTestId('recovery-codes-list')).toHaveCount(0);

    await page.getByTestId('recovery-codes-regenerate').click();
    const list = page.getByTestId('recovery-codes-list');
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(list.locator('li')).toHaveCount(10);

    // Dismissing is final for this render: the plaintext is not held anywhere
    // it could come back from.
    await page.getByRole('button', { name: /I have saved them/i }).click();
    await expect(list).toHaveCount(0);
    await expect(page.getByTestId('recovery-codes-remaining')).toContainText('10 / 10');
  } finally {
    await cleanupByEmail(email);
  }
});
