import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

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

/** The signed-in email per /api/auth/session (null when the session is dead). */
async function sessionEmail(page: Page): Promise<string | null> {
  const s = await (await page.request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

// #1543 — an admin clears a locked-out user's second factor. The parts that
// matter are not the button: the factor and the secret are gone, the target's
// live session is dead, and the reset is written down and disclosed to the
// owner rather than happening quietly.
test('admin resets a mentor\'s two-factor: factor cleared, session dead, audited and disclosed', async ({
  browser,
}) => {
  const adminEmail = uniqueEmail('r2faadmin');
  const mentorEmail = uniqueEmail('r2famentor');
  const admin = await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Reset2fa Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Reset2fa Mentor');

  const adminCtx = await browser.newContext();
  const mentorCtx = await browser.newContext();
  try {
    // The mentor is signed in on their own device, then enrols an
    // authenticator (seeded straight into the row — enrolment itself is the
    // account-owned route's business, not this one's).
    const mentorPage = await mentorCtx.newPage();
    await login(mentorPage, mentorEmail, 'MentorPass123!');
    expect(await sessionEmail(mentorPage)).toBe(mentorEmail);
    await prisma.user.update({
      where: { id: mentor.id },
      data: { twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP', lastTotpStep: 99_999_999 },
    });

    const adminPage = await adminCtx.newPage();
    await login(adminPage, adminEmail, 'AdminPass123!');
    await adminPage.goto('/admin/users');
    // AdminNav renders its own input[type="search"] on every admin page, so the
    // page-level box is addressed by its testid.
    await adminPage.getByTestId('users-search').fill(mentorEmail);
    const button = adminPage.getByTestId(`reset-2fa-${mentor.id}`);
    await expect(button).toBeVisible({ timeout: 10_000 });

    adminPage.once('dialog', (d) => d.accept());
    const done = adminPage.waitForResponse(
      (r) =>
        r.url().includes(`/api/admin/users/${mentor.id}/reset-2fa`) &&
        r.request().method() === 'POST'
    );
    await button.click();
    expect((await done).status()).toBe(200);

    // The factor, its secret and the replay high-water mark are all gone.
    const after = await prisma.user.findUnique({
      where: { id: mentor.id },
      select: { twoFactorEnabled: true, twoFactorSecret: true, lastTotpStep: true, sessionsValidFrom: true },
    });
    expect(after?.twoFactorEnabled).toBe(false);
    expect(after?.twoFactorSecret).toBeNull();
    expect(after?.lastTotpStep).toBeNull();
    expect(after?.sessionsValidFrom).not.toBeNull();

    // A factor removed from a live session is a factor removed from an
    // attacker's live session too, so the session dies with it.
    await expect.poll(async () => sessionEmail(mentorPage), { timeout: 10_000 }).toBeNull();

    // Written down (both logs) and disclosed to the account owner, naming who.
    await expect
      .poll(async () =>
        prisma.activityLog.count({ where: { action: 'admin.reset_2fa', targetId: mentor.id } })
      )
      .toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'ADMIN_RESET_2FA', targetId: mentor.id } })
    ).toBe(1);
    const notice = await prisma.notification.findFirst({
      where: { userId: mentor.id, type: 'security.twoFactorReset' },
    });
    expect(notice).not.toBeNull();
    expect(JSON.stringify(notice!.params)).toContain('Reset2fa Admin');

    // The password still works — this is a factor reset, not a lockout.
    const freshCtx = await browser.newContext();
    try {
      const fresh = await freshCtx.newPage();
      await login(fresh, mentorEmail, 'MentorPass123!');
      expect(await sessionEmail(fresh)).toBe(mentorEmail);
    } finally {
      await freshCtx.close();
    }

    // And the button is gone now that there is nothing left to reset.
    await adminPage.reload();
    await adminPage.getByTestId('users-search').fill(mentorEmail);
    await expect(adminPage.getByTestId(`user-row-${mentor.id}`)).toBeVisible({ timeout: 10_000 });
    await expect(adminPage.getByTestId(`reset-2fa-${mentor.id}`)).toHaveCount(0);

    // Authorization is server-side: resetting a PEER ADMIN is refused even
    // though the UI never offers it. Hiding the button is not the control.
    const peerEmail = uniqueEmail('r2fapeer');
    const peer = await seedUser(peerEmail, 'PeerPass123!', 'ADMIN', 'Reset2fa Peer');
    try {
      const refused = await adminPage.request.post(`/api/admin/users/${peer.id}/reset-2fa`);
      expect(refused.status()).toBe(400);
      expect((await refused.json()).code).toBe('peer_admin');
      // …and the caller's own account is refused too: the account-owned route
      // demands an authenticator code, this one does not.
      const self = await adminPage.request.post(`/api/admin/users/${admin.id}/reset-2fa`);
      expect(self.status()).toBe(400);
      expect((await self.json()).code).toBe('self_target');
      expect(
        await prisma.activityLog.count({
          where: { action: 'admin.reset_2fa_denied', actorId: admin.id },
        })
      ).toBe(2);
    } finally {
      await cleanupByEmail(peerEmail);
    }
  } finally {
    await adminCtx.close();
    await mentorCtx.close();
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
