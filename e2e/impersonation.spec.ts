import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('impersonating a company user loads that company\'s candidates', async ({ page }) => {
  const adminEmail = uniqueEmail('impco-admin');
  const companyEmail = uniqueEmail('impco-company');
  const mentorEmail = uniqueEmail('impco-mentor');
  const menteeEmail = uniqueEmail('impco-mentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'ImpCo Admin');
  const companyUser = await seedUser(companyEmail, 'x', 'COMPANY', 'ImpCo Login');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'ImpCo Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Zoltan Candidate');
  // COMPANY reads of /api/mentorship fail closed without a tenant (#1227), so
  // the impersonated company user and the relation must share an org.
  const org = await prisma.organization.create({
    data: { name: `ImpCo Org ${Date.now()}`, slug: `impco-${Date.now()}` },
  });
  const company = await prisma.company.create({ data: { name: 'ImpCo GmbH', orgId: org.id } });
  await prisma.user.update({ where: { id: companyUser.id }, data: { companyId: company.id, orgId: org.id } });
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id, orgId: org.id },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    const row = page.getByTestId(`user-row-${companyUser.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Login as' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/company'), { timeout: 20_000 });

    // The impersonated company session must carry companyId → candidates load.
    await expect(page.getByText('Zoltan Candidate')).toBeVisible({ timeout: 10_000 });
  } finally {
    await prisma.auditLog.deleteMany({ where: { targetId: companyUser.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(companyEmail);
    await cleanupByEmail(adminEmail);
    await prisma.company.deleteMany({ where: { id: company.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('admin can impersonate a user and return to their own account', async ({ page }) => {
  const adminEmail = uniqueEmail('impadmin');
  const menteeEmail = uniqueEmail('impmentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Imp Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Imp Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Start impersonating the mentee → lands on the mentee portal.
    await page.goto('/admin/users');
    const row = page.getByTestId(`user-row-${mentee.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Login as' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // The "viewing as" banner is shown, and the action was audited.
    await expect(page.getByText(/viewing the app as/i)).toBeVisible({ timeout: 10_000 });
    const started = await prisma.auditLog.findFirst({
      where: { action: 'IMPERSONATE_START', targetId: mentee.id },
    });
    expect(started).not.toBeNull();

    // …and on the screens that render their own chrome instead of the app shell:
    // Messages used to drop the banner entirely, stranding the admin in the
    // impersonated session with no visible way back.
    await page.goto('/messages');
    await expect(page.getByTestId('impersonation-banner')).toBeVisible({ timeout: 10_000 });
    await page.goto('/account');
    await expect(page.getByTestId('impersonation-banner')).toBeVisible({ timeout: 10_000 });

    // Return to the admin account — from a shell-less screen, which is the point.
    await page.getByRole('button', { name: /Return to your account/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    await expect(page.getByText(/viewing the app as/i)).toHaveCount(0);
  } finally {
    await prisma.auditLog.deleteMany({ where: { targetId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('the account page hides credential + delete cards while impersonating', async ({ page }) => {
  const adminEmail = uniqueEmail('impacct-admin');
  const menteeEmail = uniqueEmail('impacct-mentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'ImpAcct Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'ImpAcct Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Sanity check: on the admin's OWN account page the danger zone is there.
    await page.goto('/account');
    await expect(page.getByTestId('delete-account-card')).toBeVisible({ timeout: 10_000 });

    await page.goto('/admin/users');
    const row = page.getByTestId(`user-row-${mentee.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Login as' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    // Impersonated: /api/account rejects credential changes and deletion, so the
    // cards must not be offered — they used to ask for a password the admin
    // cannot know, and would have 400'd even with the right one.
    await page.goto('/account');
    await expect(page.getByTestId('impersonation-account-notice')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('delete-account-card')).toHaveCount(0);
    await expect(page.locator('#email-current-password')).toHaveCount(0);
    await expect(page.locator('#delete-current-password')).toHaveCount(0);
  } finally {
    await prisma.auditLog.deleteMany({ where: { targetId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});

// #1039 — an impersonating admin must not be able to touch the account holder's
// second factor (enrolling an authenticator only the admin holds, or stripping
// the one that protects the owner) or revoke every device they are signed in on.
test('impersonation cannot change 2FA or sign out the user\'s devices', async ({ page }) => {
  const adminEmail = uniqueEmail('imp2fa-admin');
  const menteeEmail = uniqueEmail('imp2fa-mentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Imp2fa Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Imp2fa Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Sanity check: on the admin's OWN account page both cards are offered.
    await page.goto('/account');
    await expect(page.getByTestId('two-factor-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('sessions-card')).toBeVisible();

    await page.goto('/admin/users');
    const row = page.getByTestId(`user-row-${mentee.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Login as' }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });

    await page.goto('/account');
    await expect(page.getByTestId('impersonation-account-notice')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('two-factor-card')).toHaveCount(0);
    await expect(page.getByTestId('sessions-card')).toHaveCount(0);

    // The endpoints refuse it too — hiding the cards is not the guard.
    for (const action of ['setup', 'enable', 'disable']) {
      const res = await page.request.post('/api/account/2fa', {
        data: { action, code: '123456' },
      });
      expect(res.status(), `2fa ${action} while impersonating`).toBe(400);
    }
    const signOut = await page.request.post('/api/account/sign-out-all');
    expect(signOut.status()).toBe(400);

    // Reading the status stays allowed, and nothing was written to the account:
    // no pending secret from the rejected `setup`, no session cutoff.
    expect((await page.request.get('/api/account/2fa')).status()).toBe(200);
    const after = await prisma.user.findUnique({
      where: { id: mentee.id },
      select: { twoFactorEnabled: true, twoFactorSecret: true, sessionsValidFrom: true },
    });
    expect(after?.twoFactorEnabled).toBeFalsy();
    expect(after?.twoFactorSecret).toBeNull();
    expect(after?.sessionsValidFrom).toBeNull();

    // The impersonation session survived — the admin can still get back out.
    await expect(page.getByTestId('impersonation-banner')).toBeVisible();
  } finally {
    await prisma.auditLog.deleteMany({ where: { targetId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
