import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can trigger a password reset for a user and gets a shareable link', async ({ page }) => {
  const adminEmail = uniqueEmail('rstadmin');
  const menteeEmail = uniqueEmail('rstmentee');
  await seedUser(adminEmail, 'AdminPass123!', 'ADMIN', 'Reset Admin');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Reset Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123!');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto(`/admin/candidates/${mentee.id}`);
    const done = page.waitForResponse(
      (r) => r.url().includes(`/api/admin/users/${mentee.id}/reset-password`) && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Reset password/ }).click();
    await done;

    // The shareable reset link is shown and a token was persisted.
    const link = await page.locator('input[readonly]').inputValue();
    expect(link).toContain('/auth/reset?token=');
    const token = await prisma.passwordResetToken.findFirst({
      where: { userId: mentee.id, used: false },
    });
    expect(token).not.toBeNull();
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
