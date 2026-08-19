import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser } from './helpers/auth';

// Admin converts an account between MENTOR and MENTEE (#1243). The endpoint
// revokes the target's sessions (role lives in the JWT until re-login), so the
// spec also proves the converted user's pre-conversion session dies.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin converts a mentee to a mentor; the old session is revoked', async ({ page, browser }) => {
  const adminEmail = uniqueEmail('convadmin');
  const menteeEmail = uniqueEmail('convmentee');
  // Created inside the try so a failure between here and the finally can't
  // skip the cleanup — a leaked context lingers for the whole worker, and on
  // a BASE_URL run orphaned seed rows accumulate in the shared preview DB.
  let menteeCtx: Awaited<ReturnType<typeof browser.newContext>> | undefined;

  try {
    await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Convert Admin');
    const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Convert Mentee');

    // The mentee signs in on their own browser first — this session must not
    // survive the conversion.
    menteeCtx = await browser.newContext();
    const menteePage = await menteeCtx.newPage();
    await signInAsFreshUser(menteePage, menteeEmail, 'MenteePass123!', '/portal');

    await signInAsFreshUser(page, adminEmail, 'AdminPass123!', '/admin');
    // gotoSettled: a deep link straight after sign-in can lose the race with
    // the landing-page redirect ("interrupted by another navigation" — the
    // flake class documented in helpers/auth.ts).
    await gotoSettled(page, '/admin/users');
    const row = page.getByTestId(`user-row-${mentee.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Open the confirm panel and convert.
    await row.getByTestId(`convert-role-${mentee.id}`).click();
    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/users/${mentee.id}`) && r.request().method() === 'PATCH'
    );
    await page.getByTestId(`convert-role-confirm-${mentee.id}`).click();
    // Surface an endpoint failure as itself, not as a downstream DB mismatch.
    expect((await patched).ok()).toBeTruthy();

    const updated = await prisma.user.findUnique({ where: { id: mentee.id } });
    expect(updated!.role).toBe('MENTOR');
    // The conversion must stamp the sign-out-all cutoff — without it a live
    // token would keep the old role until it happens to refresh.
    expect(updated!.sessionsValidFrom).not.toBeNull();

    // The row re-renders as a mentor and now offers the way back.
    await expect(row.getByTestId(`convert-role-${mentee.id}`)).toHaveText('Make mentee', { timeout: 10_000 });

    // The person is told what happened (#1252): an in-app notice waits for
    // them after the forced re-login, pointing at their new home shell…
    const note = await prisma.notification.findFirst({ where: { userId: mentee.id, type: 'role_changed.toMentor' } });
    expect(note).not.toBeNull();
    expect(note!.link).toBe('/mentor');
    // …and an account email goes out. Fire-and-forget on the server, so poll;
    // with no SMTP configured locally it is logged as SKIPPED — the row is the
    // assertion, not the delivery.
    await expect
      .poll(
        () => prisma.emailLog.count({ where: { to: menteeEmail, category: 'account' } }),
        { timeout: 10_000 }
      )
      .toBeGreaterThan(0);

    // The pre-conversion session is rejected on its next request.
    await menteePage.goto('/portal');
    await expect(menteePage).toHaveURL(/\/auth\/signin/, { timeout: 15_000 });
  } finally {
    await menteeCtx?.close();
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('role conversion refuses ADMIN targets and ADMIN grants', async ({ page }) => {
  const adminEmail = uniqueEmail('convadmin2');
  const otherAdminEmail = uniqueEmail('convtargetadmin');
  const mentorEmail = uniqueEmail('convmentor');
  try {
    await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Convert Admin Two');
    const otherAdmin = await seedUser(otherAdminEmail, 'AdminPass123!', 'ADMIN', 'Target Admin');
    const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Target Mentor');

    await signInAsFreshUser(page, adminEmail, 'AdminPass123!', '/admin');

    // An ADMIN account cannot be converted…
    const demote = await page.request.patch(`/api/users/${otherAdmin.id}`, { data: { role: 'MENTEE' } });
    expect(demote.status()).toBe(400);

    // …and ADMIN (or any non-people role) cannot be granted.
    for (const role of ['ADMIN', 'COMPANY', 'SOURCE', 'bogus']) {
      const res = await page.request.patch(`/api/users/${mentor.id}`, { data: { role } });
      expect(res.status()).toBe(400);
    }

    const untouched = await prisma.user.findUnique({ where: { id: mentor.id } });
    expect(untouched!.role).toBe('MENTOR');
    expect((await prisma.user.findUnique({ where: { id: otherAdmin.id } }))!.role).toBe('ADMIN');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(otherAdminEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('role conversion is offered on the admin profile page too', async ({ page }) => {
  const adminEmail = uniqueEmail('convadmin3');
  const mentorEmail = uniqueEmail('convmentor3');
  try {
    await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Convert Admin Three');
    const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Profile Target Mentor');

    await signInAsFreshUser(page, adminEmail, 'AdminPass123!', '/admin');
    await gotoSettled(page, `/admin/mentors/${mentor.id}`);

    await page.getByTestId(`convert-role-${mentor.id}`).click();
    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/users/${mentor.id}`) && r.request().method() === 'PATCH'
    );
    await page.getByTestId(`convert-role-confirm-${mentor.id}`).click();
    expect((await patched).ok()).toBeTruthy();

    const updated = await prisma.user.findUnique({ where: { id: mentor.id } });
    expect(updated!.role).toBe('MENTEE');
  } finally {
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
