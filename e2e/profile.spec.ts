import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('mentee can save the new profile fields (city, whatsapp)', async ({ page }) => {
  const email = uniqueEmail('mentee');
  const password = 'ProfPass123!';
  await seedUser(email, password, 'MENTEE', 'Profile Mentee');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/portal/profile');
    await page.getByLabel('City').fill('Monheim');
    await page.getByLabel('WhatsApp').fill('+491631681948');
    await page.getByRole('button', { name: /save/i }).click();
    // Both the inline banner and a toast now show this message — either
    // proves the save succeeded and was surfaced to the user.
    await expect(page.getByText(/updated successfully/i).first()).toBeVisible({ timeout: 10_000 });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.city).toBe('Monheim');
    expect(user?.whatsapp).toBe('+491631681948');
  } finally {
    await cleanupByEmail(email);
  }
});
