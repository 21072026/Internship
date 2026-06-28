import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function adminLogin(page: import('@playwright/test').Page, email: string, pw: string) {
  await page.goto('/auth/signin');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"]', pw);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });
}

test('candidates can be exported to Excel (.xlsx)', async ({ page }) => {
  const adminEmail = uniqueEmail('xls-admin');
  const mentorEmail = uniqueEmail('xls-mentor');
  const menteeEmail = uniqueEmail('xls-mentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Xls Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Xls Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Xls Candidate');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });

  try {
    await adminLogin(page, adminEmail, 'AdminPass123');
    await page.goto('/admin/candidates');
    await expect(page.getByText('Xls Candidate')).toBeVisible({ timeout: 10_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Excel' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { id: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('analytics page offers print and Excel export', async ({ page }) => {
  const adminEmail = uniqueEmail('xls-an-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Xls An Admin');
  try {
    await adminLogin(page, adminEmail, 'AdminPass123');
    await page.goto('/admin/analytics');
    await expect(page.getByRole('button', { name: 'Print / PDF' })).toBeVisible({ timeout: 10_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Excel' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  } finally {
    await cleanupByEmail(adminEmail);
  }
});
