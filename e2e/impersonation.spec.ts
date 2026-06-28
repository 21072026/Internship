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
  const company = await prisma.company.create({ data: { name: 'ImpCo GmbH' } });
  await prisma.user.update({ where: { id: companyUser.id }, data: { companyId: company.id } });
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id, companyId: company.id },
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

    // Return to the admin account.
    await page.getByRole('button', { name: /Return to your account/ }).click();
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
    await expect(page.getByText(/viewing the app as/i)).toHaveCount(0);
  } finally {
    await prisma.auditLog.deleteMany({ where: { targetId: mentee.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
