import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// P0: a self-registered user whose email is not verified (e.g. their link
// expired) must NOT be told the account is "deactivated" — they must be able
// to request a fresh verification link from the sign-in page.
test('unverified user gets a verify prompt + can resend, not a deactivated dead-end', async ({ page }) => {
  const email = uniqueEmail('unverified');
  const user = await seedUser(email, 'Pass1234!', 'MENTEE', 'Unverified User');
  // Simulate a never-activated self-registration whose link expired.
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: false, isActive: false } });

  try {
    await page.goto('/auth/signin');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill('Pass1234!');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Message is about verification, NOT "deactivated".
    await expect(page.getByText(/not verified/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/deactivated/i)).toHaveCount(0);

    // Resend issues a fresh verification token for this user.
    const before = await prisma.emailVerificationToken.count({ where: { userId: user.id } });
    await page.getByRole('button', { name: /resend verification/i }).click();
    await expect(page.getByText(/on its way|check your inbox/i)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBeGreaterThan(before);
  } finally {
    await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
    await cleanupByEmail(email);
  }
});
