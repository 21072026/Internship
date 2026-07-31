import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * #868: changing the password did not write `sessionsValidFrom`, so a stolen
 * cookie stayed valid for the rest of its 12-hour life. Noticing the theft and
 * changing your password — the one thing everybody knows to do — locked out
 * nobody. The revocation machinery already existed; only the write was missing.
 */
test('changing the password kills sessions on other devices', { tag: '@smoke' }, async ({ page, browser }) => {
  const email = uniqueEmail('revoke');
  const oldPw = 'RevokeOld123';
  const newPw = 'RevokeNew456';
  await seedUser(email, oldPw, 'MENTEE', 'Revoke Mentee');

  // A second, independent browser context standing in for the other device.
  // It needs the same seeded consent state as the fixture context, or the
  // cookie banner sits over the sign-in form.
  const attacker = await browser.newContext({ storageState: './e2e/.state/consent.json' });
  const attackerPage = await attacker.newPage();

  try {
    await signInAndSettle(attackerPage, email, oldPw, '/portal');
    expect((await attackerPage.request.get('/api/profile')).status()).toBe(200);

    await signInAndSettle(page, email, oldPw, '/portal');
    const res = await page.request.put('/api/account', {
      data: { currentPassword: oldPw, newPassword: newPw },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).sessionsRevoked).toBe(true);

    // The other device's cookie is refused on its very next request.
    await expect.poll(async () => (await attackerPage.request.get('/api/profile')).status(), { timeout: 15_000 })
      .toBe(401);
  } finally {
    await attacker.close();
    await cleanupByEmail(email);
    await prisma.$disconnect();
  }
});
