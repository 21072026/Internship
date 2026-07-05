import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #483: the authenticated "resend verification email" banner used to always
// report success even when the send failed server-side, because the API
// unconditionally returned { ok: true }. Now a real failure surfaces as a
// non-2xx response the banner can show an error for. CI has no SMTP configured
// (sendEmail no-ops cleanly in that case — same as every other email flow in
// this suite), so this covers the happy path + the "already verified" and
// "not signed in" edges; the failure branch was verified by code review since
// it can't be triggered without a real broken SMTP connection.
test('signed-in unverified user can resend from the dashboard banner and gets a fresh token', async ({ page }) => {
  const email = uniqueEmail('resend-mentor');
  const user = await seedUser(email, 'MentorPass123', 'MENTOR', 'Resend Mentor');
  await prisma.user.update({ where: { id: user.id }, data: { emailVerified: false } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    // The dashboard banner reads "isn't verified" (distinct wording/key from
    // the sign-in page's "is not verified" message tested in unverified-login.spec.ts).
    await expect(page.getByText(/isn.t verified/i)).toBeVisible({ timeout: 10_000 });

    const before = await prisma.emailVerificationToken.count({ where: { userId: user.id } });
    const done = page.waitForResponse((r) => r.url().includes('/api/auth/verify-email/resend') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /resend verification/i }).click();
    const res = await done;
    expect(res.ok()).toBeTruthy();

    await expect(page.getByText(/verification email sent/i)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => prisma.emailVerificationToken.count({ where: { userId: user.id } })).toBeGreaterThan(before);
  } finally {
    await prisma.emailVerificationToken.deleteMany({ where: { userId: user.id } });
    await cleanupByEmail(email);
  }
});

test('resend API is a no-op once the account is already verified', async ({ page }) => {
  const email = uniqueEmail('resend-verified');
  const user = await seedUser(email, 'MentorPass123', 'MENTOR', 'Already Verified');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', 'MentorPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });

    const res = await page.request.post('/api/auth/verify-email/resend');
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).alreadyVerified).toBe(true);
  } finally {
    await cleanupByEmail(email);
  }
});
