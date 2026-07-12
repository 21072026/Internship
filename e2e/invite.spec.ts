import { test, expect } from '@playwright/test';
import { prisma, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin invite surfaces a shareable registration link', { tag: '@smoke' }, async ({ page }) => {
  const email = uniqueEmail('invitee');
  try {
    // Sign in as admin and open the invite page
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });
    await page.goto('/admin/invite');

    // Send an invitation
    await page.fill('input[type="email"]', email);
    await page.click('button[type="submit"]');

    // A shareable register link is shown (regardless of email delivery)
    const linkInput = page.locator(`input[value*="/auth/register?token="]`);
    await expect(linkInput).toBeVisible({ timeout: 10_000 });
    const value = await linkInput.inputValue();
    expect(value).toContain('/auth/register?token=');

    // It was persisted as an invitation token
    const token = await prisma.invitationToken.findFirst({ where: { email } });
    expect(token).not.toBeNull();
  } finally {
    await cleanupByEmail(email);
  }
});
