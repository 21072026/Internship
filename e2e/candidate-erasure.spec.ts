import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can anonymize a candidate (wrong-name confirm is rejected)', async ({ page }) => {
  const adminEmail = uniqueEmail('erase-admin');
  const menteeEmail = uniqueEmail('erase-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Erase Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Anonymize Me');
  await prisma.user.update({ where: { id: mentee.id }, data: { university: 'TU Munich', city: 'Munich' } });
  await prisma.cvFile.create({
    data: { userId: mentee.id, filename: 'cv.pdf', contentType: 'application/pdf', size: 3, data: Buffer.from('abc') },
  });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByText(/Danger zone/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^Anonymize$/i }).click();

    // Wrong name → the confirm button stays disabled; nothing happens.
    const nameInput = page.getByTestId('erasure-confirm-name');
    await nameInput.fill('Wrong Name');
    await expect(page.getByRole('button', { name: /^Yes, anonymize$/i })).toBeDisabled();

    // Correct name → succeeds.
    await nameInput.fill('Anonymize Me');
    await page.getByRole('button', { name: /^Yes, anonymize$/i }).click();

    await expect(async () => {
      const after = await prisma.user.findUnique({ where: { id: mentee.id } });
      expect(after?.fullName).toBe('Erased candidate');
      expect(after?.university).toBeNull();
      expect(after?.isActive).toBe(false);
      const cv = await prisma.cvFile.findUnique({ where: { userId: mentee.id } });
      expect(cv).toBeNull();
    }).toPass({ timeout: 10_000 });
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { menteeId: mentee.id } });
    await prisma.user.deleteMany({ where: { id: mentee.id } });
    await cleanupByEmail(adminEmail);
  }
});

test('admin can permanently delete a candidate; the erase endpoint refuses non-MENTEE targets', async ({ page }) => {
  const adminEmail = uniqueEmail('erase-admin2');
  const menteeEmail = uniqueEmail('erase-mentee2');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Erase Admin 2');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Delete Me Fully');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    await expect(page.getByText(/Danger zone/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^Delete permanently$/i }).click();
    await page.getByTestId('erasure-confirm-name').fill('Delete Me Fully');
    await page.getByRole('button', { name: /^Yes, delete permanently$/i }).click();

    await page.waitForURL('**/admin/candidates', { timeout: 10_000 });
    await expect.poll(async () => prisma.user.findUnique({ where: { id: mentee.id } })).toBeNull();

    // Guard: targeting a non-MENTEE (the admin itself) is refused.
    const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
    const guardRes = await page.request.post(`/api/admin/users/${admin!.id}/erase`, {
      data: { mode: 'delete', confirmName: admin!.fullName },
    });
    expect(guardRes.status()).toBe(404);
    const adminAfter = await prisma.user.findUnique({ where: { id: admin!.id } });
    expect(adminAfter).not.toBeNull();
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
