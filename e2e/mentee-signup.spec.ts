import { test, expect } from '@playwright/test';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #589: token-less self-registration is the mentee intake — it creates a MENTEE,
// unverified and inactive. What lets that account in is the emailed link: with
// the `selfRegistration` setting on its default 'auto', verifying the address
// activates the account, so the front door is open without an admin in the loop.
test('self-registration opens the account once the email is verified', { tag: '@smoke' }, async ({ page }) => {
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

    // Created as a MENTEE, inactive and unverified — the address is unproven.
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.role).toBe('MENTEE');
    expect(user?.isActive).toBe(false);
    expect(user?.emailVerified).toBe(false);
    expect(user?.pendingApproval).toBe(false);

    // Sign-in is refused while the address is unproven.
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/auth\/signin/);

    // Clicking the link from the verification email is the whole approval step.
    const token = await prisma.emailVerificationToken.findFirst({
      where: { userId: user!.id, used: false },
      orderBy: { createdAt: 'desc' },
    });
    expect(token).not.toBeNull();
    const res = await page.request.post('/api/auth/verify-email', { data: { token: token!.token } });
    expect(res.ok()).toBeTruthy();

    const verified = await prisma.user.findUnique({ where: { email } });
    expect(verified?.emailVerified).toBe(true);
    expect(verified?.isActive).toBe(true);

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

// The escape hatch: with `selfRegistration = manual` the same flow parks the
// account for an admin, and verifying the address must NOT let it in.
test('manual mode parks a self-registration for an admin', async ({ page }) => {
  const email = uniqueEmail('manualmentee');
  const password = 'MenteeSignup123!';

  await prisma.setting.upsert({
    where: { key: 'selfRegistration' },
    create: { key: 'selfRegistration', value: 'manual' },
    update: { value: 'manual' },
  });

  try {
    await page.goto('/auth/register');
    await page.fill('input[name="fullName"]', 'Manual Mode Mentee');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await page.fill('input[name="confirmPassword"]', password);
    await page.check('input[name="consent"]');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.isActive).toBe(false);
    expect(user?.pendingApproval).toBe(true);

    const token = await prisma.emailVerificationToken.findFirst({
      where: { userId: user!.id, used: false },
      orderBy: { createdAt: 'desc' },
    });
    const res = await page.request.post('/api/auth/verify-email', { data: { token: token!.token } });
    expect(res.ok()).toBeTruthy();

    // Verified, but still waiting on a human — the email click cannot override it.
    const after = await prisma.user.findUnique({ where: { email } });
    expect(after?.emailVerified).toBe(true);
    expect(after?.isActive).toBe(false);
  } finally {
    await cleanupByEmail(email);
    // Leave the shared DB on the default, or every later test inherits 'manual'.
    await prisma.setting.upsert({
      where: { key: 'selfRegistration' },
      create: { key: 'selfRegistration', value: 'auto' },
      update: { value: 'auto' },
    });
  }
});

// #1095: the form must not read as "invitation required". The token field is
// folded away for a visitor arriving without one, and unfolded for a visitor
// who arrived through an invitation link.
test('the register form hides the invitation field unless you arrived with one', async ({ page }) => {
  await page.goto('/auth/register');
  await expect(page.locator('input[name="token"]')).toHaveCount(0);
  const toggle = page.getByTestId('have-invite-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('input[name="token"]')).toBeVisible();

  // Arriving through an invitation link unfolds it without a click.
  await page.goto('/auth/register?token=e2e-not-a-real-token');
  await expect(page.locator('input[name="token"]')).toBeVisible();
});
