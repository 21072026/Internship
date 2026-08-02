import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Admin-side account deletion from the user list. The counterpart of the
// self-service delete: there the account holder proves who they are with their
// own password, here the ADMIN does — the target's password is unknowable to an
// admin, which is what made deleting from an impersonated session impossible.
test('admin erases a mentor account from the user list; a wrong admin password is refused', async ({ page }) => {
  const adminEmail = uniqueEmail('uerase-admin');
  const mentorEmail = uniqueEmail('uerase-mentor');
  const admin = await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'UErase Admin');
  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Erasable Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    await expect(page.getByTestId(`user-row-${mentor.id}`)).toBeVisible({ timeout: 10_000 });

    // Admin rows carry no erase button — the endpoint refuses ADMIN targets, so
    // the last admin account can't be erased out from under the tenant.
    await expect(page.getByTestId(`erase-user-${admin.id}`)).toHaveCount(0);

    await page.getByTestId(`erase-user-${mentor.id}`).click();
    // Anonymizing only preserves pipeline history for candidates, so a mentor
    // gets permanent deletion or nothing.
    await expect(page.getByRole('button', { name: /^Anonymize$/i })).toHaveCount(0);
    await page.getByRole('button', { name: /^Delete permanently$/i }).click();

    await page.getByTestId('erasure-confirm-name').fill('Erasable Mentor');
    await page.getByTestId('erasure-admin-password').fill('WrongPass123!');
    await page.getByRole('button', { name: /^Yes, delete permanently$/i }).click();
    await expect(page.getByTestId('erasure-error')).toBeVisible({ timeout: 10_000 });
    expect(await prisma.user.findUnique({ where: { id: mentor.id } })).not.toBeNull();

    // Correct password → the account is gone, and the deletion is audited
    // against the admin who did it (not against the erased user).
    await page.getByTestId('erasure-admin-password').fill('AdminPass123!');
    await page.getByRole('button', { name: /^Yes, delete permanently$/i }).click();
    await expect.poll(async () => prisma.user.findUnique({ where: { id: mentor.id } }), { timeout: 15_000 }).toBeNull();
    await expect(page.getByTestId(`user-row-${mentor.id}`)).toHaveCount(0);

    const logged = await prisma.activityLog.findFirst({
      where: { action: 'user.erase.delete', targetId: mentor.id },
    });
    expect(logged?.actorId).toBe(admin.id);
  } finally {
    await prisma.activityLog.deleteMany({ where: { targetId: mentor.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
