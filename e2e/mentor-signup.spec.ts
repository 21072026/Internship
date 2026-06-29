import { test, expect } from '@playwright/test';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('self-registration without a token creates a MENTOR', async ({ page }) => {
  const email = uniqueEmail('selfmentor');
  const password = 'MentorSignup123!';

  try {
    await page.goto('/auth/register');
    await page.fill('input[name="fullName"]', 'Self Signup Mentor');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.check('input[name="consent"]');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.role).toBe('MENTOR');

    // The new mentor can sign in and reach the mentor portal
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
