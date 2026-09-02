import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

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
