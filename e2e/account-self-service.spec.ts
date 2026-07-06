import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, pw: string, home: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith(home), { timeout: 20_000 });
}

test('a mentee can change password from /account; weak passwords are rejected', async ({ page }) => {
  const email = uniqueEmail('acctmentee');
  const oldPw = 'OldPass123!';
  const newPw = 'FreshPass456';
  const user = await seedUser(email, oldPw, 'MENTEE', 'Acct Mentee');

  try {
    await signIn(page, email, oldPw, '/portal');
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible({ timeout: 10_000 });

    // 'Current password' appears in the email card (0) and the password card (1).
    // Weak password (no uppercase) is rejected by the server policy.
    await page.getByLabel(/Current password/).nth(1).fill(oldPw);
    await page.getByLabel(/^New password/).fill('weakpass');
    await page.getByLabel(/Confirm new password/).fill('weakpass');
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText(/uppercase|at least 8/i)).toBeVisible({ timeout: 10_000 });

    // Valid password succeeds.
    await page.getByLabel(/Current password/).nth(1).fill(oldPw);
    await page.getByLabel(/^New password/).fill(newPw);
    await page.getByLabel(/Confirm new password/).fill(newPw);
    const done = page.waitForResponse((r) => r.url().includes('/api/account') && r.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Update password' }).click();
    await done;
    await page.waitForTimeout(400);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(await bcrypt.compare(newPw, fresh!.password)).toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});

test('changing email requires the correct current password', async ({ page }) => {
  const email = uniqueEmail('reauth');
  const newEmail = uniqueEmail('reauth-new');
  const pw = 'ReauthPass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Reauth Mentee');

  try {
    await signIn(page, email, pw, '/portal');
    await page.goto('/account');
    const emailForm = page.locator('form', { has: page.getByRole('button', { name: 'Update email' }) });
    const emailInput = emailForm.getByLabel(/Email address/);
    // The form fetches /api/profile on mount and sets the field to the current
    // email; wait for that to land before overwriting, or a slow fetch clobbers
    // our value and the PUT becomes a no-op 200 (this was the chronic flake).
    await expect(emailInput).toHaveValue(email, { timeout: 10_000 });
    await emailInput.fill(newEmail);
    await emailForm.getByLabel(/Current password/).fill('WrongPass999');
    // Assert on the API response (deterministic) rather than the toast, which
    // auto-dismisses after 4s and races the assertion. Wrong password → 400.
    const done = page.waitForResponse(
      (r) => r.url().includes('/api/account') && r.request().method() === 'PUT',
      { timeout: 20_000 }
    );
    await page.getByRole('button', { name: 'Update email' }).click();
    const res = await done;
    expect(res.status()).toBe(400);
    const after = await prisma.user.findUnique({ where: { id: user.id } });
    expect(after!.email).toBe(email); // unchanged
  } finally {
    await cleanupByEmail(email);
    await cleanupByEmail(newEmail);
  }
});

test('a user can delete their own account', async ({ page }) => {
  const email = uniqueEmail('delmentee');
  const pw = 'DeletePass123';
  const user = await seedUser(email, pw, 'MENTEE', 'Delete Me');

  try {
    await signIn(page, email, pw, '/portal');
    await page.goto('/account');
    await page.getByRole('button', { name: 'Delete my account' }).click();
    // After opening the confirm box, the delete card adds a third 'Current password'.
    await page.getByLabel(/Current password/).nth(2).fill(pw); // re-auth required
    const done = page.waitForResponse((r) => r.url().includes('/api/account') && r.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Yes, delete' }).click();
    await done;

    await expect.poll(async () => prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  } finally {
    await cleanupByEmail(email);
  }
});
