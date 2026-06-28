import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
}

test('unverified user is read-only until they confirm their email', async ({ page }) => {
  const email = uniqueEmail('unverified');
  const password = 'Unverified123!';
  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, password: hash, role: 'MENTOR', fullName: 'Unverified Mentor', skills: [], emailVerified: false },
  });

  try {
    // Signed in but unverified → the read-only banner is shown.
    await signIn(page, email, password);
    await expect(page.getByText(/read-only until you confirm/i)).toBeVisible();

    // A write is rejected by middleware with 403.
    const blocked = await page.request.post('/api/mentor/mentees', {
      data: { fullName: 'Should Be Blocked' },
    });
    expect(blocked.status()).toBe(403);

    // Verify the email via the link.
    const token = randomBytes(16).toString('hex');
    await prisma.emailVerificationToken.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    await page.goto(`/auth/verify?token=${token}`);
    await expect(page.getByText(/Email verified/i)).toBeVisible({ timeout: 10_000 });
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    expect(refreshed!.emailVerified).toBe(true);

    // Re-sign-in to pick up the verified flag in the session, then a write works.
    await page.context().clearCookies();
    await signIn(page, email, password);
    await expect(page.getByText(/read-only until you confirm/i)).toHaveCount(0);
    const allowed = await page.request.post('/api/mentor/mentees', {
      data: { fullName: 'Now Allowed Mentee' },
    });
    expect(allowed.status()).toBe(201);
  } finally {
    await cleanupByEmail(email);
  }
});
