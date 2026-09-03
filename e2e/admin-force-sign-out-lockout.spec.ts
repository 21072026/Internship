import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, submitSignInForm } from './helpers/auth';
import { totp } from '../src/lib/totp';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function login(page: Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
}

/** The signed-in email per /api/auth/session (null when unauthenticated). */
async function sessionEmail(page: Page): Promise<string | null> {
  const s = await (await page.request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

// #1541 — an admin can get someone out of the product now, without the much
// bigger hammer of deactivating their account. What matters is that the
// target's ALREADY OPEN session dies on its next request.
test('admin force sign-out kills the target\'s existing session', async ({ browser }) => {
  const adminEmail = uniqueEmail('fsoadmin');
  const mentorEmail = uniqueEmail('fsomentor');
  const mentorPw = 'MentorPass123!';
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Force SignOut Admin');
  const mentor = await seedUser(mentorEmail, mentorPw, 'MENTOR', 'Force SignOut Mentor');

  const adminCtx = await browser.newContext();
  const mentorCtx = await browser.newContext();
  try {
    const adminPage = await adminCtx.newPage();
    const mentorPage = await mentorCtx.newPage();

    // The target is signed in and stays signed in — this is the session the
    // admin action has to reach.
    await login(mentorPage, mentorEmail, mentorPw);
    expect(await sessionEmail(mentorPage)).toBe(mentorEmail);

    await signInAsFreshUser(adminPage, adminEmail, 'AdminPass123!', '/admin');
    await adminPage.goto('/admin/users');

    const row = adminPage.getByTestId(`user-row-${mentor.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // The control asks for confirmation before revoking anything.
    adminPage.once('dialog', (d) => d.accept());
    const posted = adminPage.waitForResponse(
      (r) => r.url().includes(`/api/admin/users/${mentor.id}/sign-out-all`) && r.request().method() === 'POST'
    );
    await row.getByTestId(`force-sign-out-${mentor.id}`).click();
    expect((await posted).ok()).toBeTruthy();

    // The mentor's existing session is rejected on its next request.
    await expect.poll(async () => sessionEmail(mentorPage), { timeout: 10_000 }).toBeNull();

    // Both halves of the hard rule ran: the cutoff and the trusted devices.
    const after = await prisma.user.findUnique({ where: { id: mentor.id } });
    expect(after!.sessionsValidFrom).not.toBeNull();
    expect(await prisma.trustedDevice.count({ where: { userId: mentor.id, revokedAt: null } })).toBe(0);
    // Audited under the admin, not the target.
    expect(
      await prisma.auditLog.count({ where: { action: 'ADMIN_SIGN_OUT_ALL', targetId: mentor.id } })
    ).toBeGreaterThan(0);

    // Not a ban: the password still works.
    const freshCtx = await browser.newContext();
    try {
      const fresh = await freshCtx.newPage();
      await login(fresh, mentorEmail, mentorPw);
      expect(await sessionEmail(fresh)).toBe(mentorEmail);
    } finally {
      await freshCtx.close();
    }
  } finally {
    await adminCtx.close();
    await mentorCtx.close();
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #1541 — the lockout is a row now, so it is visible to an admin and clearable.
test('admin sees a Locked badge and can unlock a locked-out account', async ({ page }) => {
  const adminEmail = uniqueEmail('lockadmin');
  const menteeEmail = uniqueEmail('lockmentee');
  const menteePw = 'MenteePass123!';
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Lockout Admin');
  const mentee = await seedUser(menteeEmail, menteePw, 'MENTEE', 'Lockout Mentee');

  try {
    // Write the lockout directly: the point under test is that the admin can
    // see and clear it, not how many wrong passwords it takes to get there.
    await prisma.accountLockout.create({
      data: {
        email: menteeEmail.toLowerCase(),
        userId: mentee.id,
        reason: 'password',
        failedCount: 10,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    await signInAsFreshUser(page, adminEmail, 'AdminPass123!', '/admin');
    await page.goto('/admin/users');

    const row = page.getByTestId(`user-row-${mentee.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByTestId(`locked-badge-${mentee.id}`)).toBeVisible();

    const deleted = page.waitForResponse(
      (r) => r.url().includes(`/api/admin/users/${mentee.id}/lockout`) && r.request().method() === 'DELETE'
    );
    await row.getByTestId(`unlock-user-${mentee.id}`).click();
    expect((await deleted).ok()).toBeTruthy();

    // The row is gone from the table and the badge from the list.
    await expect(row.getByTestId(`locked-badge-${mentee.id}`)).toHaveCount(0, { timeout: 10_000 });
    expect(await prisma.accountLockout.count({ where: { userId: mentee.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: 'ADMIN_UNLOCK_ACCOUNT', targetId: mentee.id } })
    ).toBeGreaterThan(0);
  } finally {
    await prisma.accountLockout.deleteMany({ where: { email: menteeEmail.toLowerCase() } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #1541 regression — the durable counter is per STAGE, not per address.
//
// A single shared row would let five fumbled authenticator codes lock the
// PASSWORD stage. That is not merely stricter: once the password check is
// refused it can no longer raise `2FA_REQUIRED`, so the sign-in form never
// reveals the code field again and a legitimate 2FA user is shut out of their
// own account for the rest of the window (it also broke
// e2e/two-factor.spec.ts's sixth iteration). This proves the two counters are
// independent in both directions.
test('a locked TOTP counter does not lock the password stage', async ({ page }) => {
  const email = uniqueEmail('tfastage');
  const pw = 'StagePass123!';
  const user = await seedUser(email, pw, 'MENTEE', 'TOTP Stage');

  try {
    // Turn 2FA on for the account…
    await signInAsFreshUser(page, email, pw, '/portal');
    const setup = await (
      await page.request.post('/api/account/2fa', { data: { action: 'setup' } })
    ).json();
    await page.request.post('/api/account/2fa', {
      data: { action: 'enable', code: totp(setup.secret) },
    });

    // …then lock ONLY the totp counter, as five wrong codes would.
    await prisma.accountLockout.create({
      data: {
        email: email.toLowerCase(),
        userId: user.id,
        reason: 'totp',
        failedCount: 5,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    // The password stage still runs, so the form learns a code is wanted.
    await submitSignInForm(page, email, pw);
    const field = page.getByLabel('Authenticator code');
    await expect(field).toBeVisible({ timeout: 10_000 });

    // …and an actually-submitted code is refused by the durable totp gate.
    await field.fill('123456');
    await page.click('button[type="submit"]');
    await expect(page.getByText(/Too many attempts/i)).toBeVisible({ timeout: 10_000 });

    // The password counter was never touched by any of this.
    expect(
      await prisma.accountLockout.count({ where: { email: email.toLowerCase(), reason: 'password' } })
    ).toBe(0);
  } finally {
    await prisma.accountLockout.deleteMany({ where: { email: email.toLowerCase() } });
    await cleanupByEmail(email);
  }
});
