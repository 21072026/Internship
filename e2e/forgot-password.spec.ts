import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('user can reset password via the forgot-password flow and sign in', async ({ page }) => {
  const email = uniqueEmail('forgot');
  const oldPw = 'OldPass123!';
  const newPw = 'BrandNew456!';
  const user = await seedUser(email, oldPw, 'ADMIN', 'Forgot Tester');

  try {
    // 1. Request a reset link.
    await page.goto('/auth/forgot');
    await page.getByLabel(/Email address/).fill(email);
    const sent = page.waitForResponse(
      (r) => r.url().includes('/api/auth/forgot') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Send reset link/ }).click();
    await sent;
    // Generic confirmation regardless of whether the account exists.
    await expect(page.getByText(/we’ve sent a password reset link|If an account exists/)).toBeVisible();

    // 2. Grab the token the API created (email isn't actually delivered in tests).
    const record = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id, used: false },
      orderBy: { createdAt: 'desc' },
    });
    expect(record).not.toBeNull();

    // 3. Follow the reset link and set a new password.
    await page.goto(`/auth/reset?token=${record!.token}`);
    await page.getByLabel(/New password/).fill(newPw);
    await page.getByLabel(/Confirm Password/i).fill(newPw);
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/auth/reset') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Update password/ }).click();
    await done;
    await page.waitForURL((u) => u.pathname.startsWith('/auth/signin'), { timeout: 20_000 });

    // 4. The new password works and the old one is gone.
    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(newPw, fresh!.password)).toBe(true);
    expect(await bcrypt.compare(oldPw, fresh!.password)).toBe(false);

    // 5. Token is single-use.
    const reused = await prisma.passwordResetToken.findUnique({ where: { id: record!.id } });
    expect(reused!.used).toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});
