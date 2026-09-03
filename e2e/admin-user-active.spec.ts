import { test, expect, type Page } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, submitSignInForm } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Plain sign-in in a context of its own (each role gets its own browser here,
// so the fresh-user cookie dance of signInAsFreshUser is not needed).
async function signIn(page: Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 20_000 });
}

// The signed-in email per /api/auth/session (null once the session is revoked).
async function sessionEmail(page: Page): Promise<string | null> {
  const s = await (await page.request.get('/api/auth/session')).json();
  return s?.user?.email ?? null;
}

test('admin deactivates a user and that user can no longer sign in', async ({ page }) => {
  const adminEmail = uniqueEmail('actadmin');
  const mentorEmail = uniqueEmail('actmentor');
  const mentorPw = 'MentorPass123!';
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Active Admin');
  const mentor = await seedUser(mentorEmail, mentorPw, 'MENTOR', 'Toggle Mentor');

  try {
    // Admin signs in and opens the Users page.
    await signInAsFreshUser(page, adminEmail, 'AdminPass123!', '/admin');

    await page.goto('/admin/users');
    // Deactivate the seeded mentor via its row.
    const row = page.getByTestId(`user-row-${mentor.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/users/${mentor.id}`) && r.request().method() === 'PATCH'
    );
    await row.getByRole('button', { name: 'Deactivate' }).click();
    await patched;

    const updated = await prisma.user.findUnique({ where: { id: mentor.id } });
    expect(updated!.isActive).toBe(false);
    // Switching off a verified account is not the same as parking a sign-up for
    // review: pendingApproval is what keeps those two apart on the sign-in page
    // (#1085), so an admin's "off" must not borrow it.
    expect(updated!.pendingApproval).toBe(false);

    // The deactivated mentor cannot sign in.
    // submitSignInForm, not signInAsFreshUser: a deactivated account is *supposed*
    // to stay on /auth/signin, so there is no landing page to wait for.
    await submitSignInForm(page, mentorEmail, mentorPw);
    await expect(page.getByText(/deactivated/i)).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname).toContain('/auth/signin');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

// Deactivation has to end the sessions the account ALREADY has, not just block
// the next sign-in (#1539). `isActive` is only read at sign-in, so before the
// fix an admin could switch someone off and that person kept browsing on their
// existing 12-hour JWT until it expired by itself. Asserting the badge — or a
// failed *fresh* login, as the test above does — passes either way; the only
// proof is an already-signed-in session being rejected on its next request.
test('deactivating a user kills the session that user already has', async ({ browser }) => {
  const adminEmail = uniqueEmail('killadmin');
  const menteeEmail = uniqueEmail('killmentee');
  const menteePw = 'MenteePass123!';
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Session Kill Admin');
  const mentee = await seedUser(menteeEmail, menteePw, 'MENTEE', 'Session Kill Mentee');

  // A remembered device, as if the mentee had ticked "keep me signed in". A
  // cutoff that leaves this row alive revokes nothing: the browser mints a
  // fresh session on its next visit (docs/remember-me.md).
  const device = await prisma.trustedDevice.create({
    data: {
      userId: mentee.id,
      tokenHash: `e2e-${mentee.id}`,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  });

  const menteeCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  try {
    const menteePage = await menteeCtx.newPage();
    const adminPage = await adminCtx.newPage();

    // The mentee is signed in and stays that way for the whole test — this is
    // the live session the deactivation must take down.
    await signIn(menteePage, menteeEmail, menteePw);
    expect(await sessionEmail(menteePage)).toBe(menteeEmail);

    // A second, independent browser: the admin switches the account off.
    await signIn(adminPage, adminEmail, 'AdminPass123!');
    const res = await adminPage.request.patch(`/api/users/${mentee.id}`, {
      data: { isActive: false },
    });
    expect(res.ok()).toBeTruthy();

    const updated = await prisma.user.findUnique({ where: { id: mentee.id } });
    expect(updated!.isActive).toBe(false);
    // The cutoff is what lib/auth.ts checks on every request.
    expect(updated!.sessionsValidFrom).not.toBeNull();

    // ...and the remembered device is gone with it.
    const storedDevice = await prisma.trustedDevice.findUnique({ where: { id: device.id } });
    expect(storedDevice!.revokedAt).not.toBeNull();

    // The mentee's EXISTING session is rejected on its next request.
    await expect.poll(async () => sessionEmail(menteePage), { timeout: 15_000 }).toBeNull();

    // ...so the next page they open sends them to the sign-in form.
    await menteePage.goto('/portal');
    await menteePage.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 20_000 });
    await expect(menteePage.locator('input[type="password"]')).toBeVisible();
  } finally {
    await menteeCtx.close();
    await adminCtx.close();
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
