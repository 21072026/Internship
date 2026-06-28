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
    // 'Current password' appears in both the email card (0) and password card (1).
    await page.getByLabel(/Current password/).nth(1).fill(oldPw);
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

test('changing email updates the sidebar without a re-login', async ({ page }) => {
  const email = uniqueEmail('acct-mail');
  const newEmail = uniqueEmail('acct-mail-new');
  const pw = 'MailPass123!';
  await seedUser(email, pw, 'ADMIN', 'Mail Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/account');
    // sidebar shows the original email
    await expect(page.getByText(email, { exact: true })).toBeVisible();

    const emailForm = page.locator('form', { has: page.getByRole('button', { name: 'Update email' }) });
    await emailForm.getByLabel(/Email address/).fill(newEmail);
    await emailForm.getByLabel(/Current password/).fill(pw); // re-auth required
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/account') && r.request().method() === 'PUT'
    );
    await page.getByRole('button', { name: 'Update email' }).click();
    await done;

    // sidebar reflects the new email immediately (session refreshed, no re-login)
    await expect(page.getByText(newEmail, { exact: true })).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(email);
    await cleanupByEmail(newEmail);
  }
});
