import { test, expect } from '@playwright/test';
import { prisma, seedInvite, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee lifecycle: invite token -> register -> login -> portal', async ({ page }) => {
  const email = uniqueEmail('mentee');
  const password = 'MenteePass123!';
  const token = await seedInvite(email, 'MENTEE');

  try {
    // Register using the invitation token
    await page.goto(`/auth/register?token=${token}`);
    await page.fill('input[name="token"]', token);
    await page.fill('input[name="fullName"]', 'E2E Mentee');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.check('input[name="consent"]');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    // The account now exists in the DB
    const created = await prisma.user.findUnique({ where: { email } });
    expect(created?.role).toBe('MENTEE');

    // Log in as the new mentee
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/portal'), { timeout: 20_000 });
    await expect(page.getByText(/welcome/i)).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});

test('mentor can sign in and reach the mentor dashboard', async ({ page }) => {
  const email = uniqueEmail('mentor');
  const password = 'MentorPass123!';
  await seedUser(email, password, 'MENTOR', 'E2E Mentor');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/mentor'), { timeout: 20_000 });
    await expect(page.getByText(/mentee|welcome/i).first()).toBeVisible();
  } finally {
    await cleanupByEmail(email);
  }
});

test('mentee cannot access the admin area', async ({ page }) => {
  const email = uniqueEmail('mentee-guard');
  const password = 'MenteePass123!';
  await seedUser(email, password, 'MENTEE', 'E2E Guard Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
    // Attempt to open the admin area — layout guard should redirect away
    await page.goto('/admin');
    await page.waitForTimeout(1500);
    expect(page.url()).not.toContain('/admin');
  } finally {
    await cleanupByEmail(email);
  }
});
