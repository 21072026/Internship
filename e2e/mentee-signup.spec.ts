import { test, expect } from '@playwright/test';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #589: token-less self-registration is the mentee intake — creates a MENTEE,
// unverified + inactive until an admin approves (same safety net as before).
test('self-registration without a token creates an INACTIVE mentee pending approval', async ({ page }) => {
  const email = uniqueEmail('selfmentee');
  const password = 'MenteeSignup123!';

  try {
    await page.goto('/auth/register');
    await page.fill('input[name="fullName"]', 'Self Signup Mentee');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.check('input[name="consent"]');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // Account is created as a MENTEE but inactive (awaiting admin approval).
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.role).toBe('MENTEE');
    expect(user?.isActive).toBe(false);

    // Inactive accounts cannot sign in yet.
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/auth\/signin/);

    // After an admin activates them, sign-in works and lands on the mentee portal.
    await prisma.user.update({ where: { id: user!.id }, data: { isActive: true } });
    await page.context().clearCookies();
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
  } finally {
    await cleanupByEmail(email);
  }
});
