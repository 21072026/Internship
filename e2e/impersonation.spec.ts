import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
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
