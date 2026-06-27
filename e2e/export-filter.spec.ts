import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('candidates: city filter narrows results and CSV export downloads', async ({ page }) => {
  const aEmail = uniqueEmail('city-a');
  const bEmail = uniqueEmail('city-b');
  const tag = `ZZ${Date.now()}`;
  const a = await seedUser(aEmail, 'Pass1234!', 'MENTEE', `${tag} Koln Mentee`);
  const b = await seedUser(bEmail, 'Pass1234!', 'MENTEE', `${tag} Berlin Mentee`);
  await prisma.user.update({ where: { id: a.id }, data: { city: `Cologne${tag}` } });
  await prisma.user.update({ where: { id: b.id }, data: { city: `Berlin${tag}` } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/auth/signin'), { timeout: 20_000 });

    await page.goto('/admin/candidates');
    await page.getByPlaceholder('Filter by city').fill(`Cologne${tag}`);
    await page.waitForTimeout(1200);
    await expect(page.getByText(`${tag} Koln Mentee`)).toBeVisible();
    await expect(page.getByText(`${tag} Berlin Mentee`)).toHaveCount(0);

    // CSV export downloads
    const download = page.waitForEvent('download', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/candidates-.*\.csv/);
  } finally {
    await cleanupByEmail(aEmail);
    await cleanupByEmail(bEmail);
  }
});
