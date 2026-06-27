import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can change their password from the account page', async ({ page }) => {
  const email = uniqueEmail('acct-admin');
  const oldPw = 'OldPass123!';
  const newPw = 'NewPass456!';
  await seedUser(email, oldPw, 'ADMIN', 'Account Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', oldPw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/account');
    await page.getByLabel(/Current password/).fill(oldPw);
    await page.getByLabel(/^New password/).fill(newPw);
    await page.getByLabel(/Confirm new password/).fill(newPw);
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/account') && r.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Update password' }).click();
    await done;
    await page.waitForTimeout(500);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(await bcrypt.compare(newPw, user!.password)).toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});
