import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #474: admin/cohorts and admin/sources need a search box like the other
// admin list pages, filtering client-side by name (case-insensitive).
test('admin filters cohorts by name via the search box', async ({ page }) => {
  const adminEmail = uniqueEmail('cs-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'CS Admin');
  const cohortA = await prisma.cohort.create({ data: { name: 'Autumn Interns 2026' } });
  const cohortB = await prisma.cohort.create({ data: { name: 'Winter Batch' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/cohorts');
    await expect(page.getByText('Autumn Interns 2026')).toBeVisible();
    await expect(page.getByText('Winter Batch')).toBeVisible();

    await page.fill('input[type="search"]', 'autumn');
    await expect(page.getByText('Autumn Interns 2026')).toBeVisible();
    await expect(page.getByText('Winter Batch')).toHaveCount(0);
  } finally {
    await prisma.cohort.deleteMany({ where: { id: { in: [cohortA.id, cohortB.id] } } });
    await cleanupByEmail(adminEmail);
  }
});

test('admin filters referral sources by name via the search box', async ({ page }) => {
  const adminEmail = uniqueEmail('cs-admin2');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'CS Admin 2');
  const sourceA = await prisma.source.create({ data: { name: 'LinkedIn Campaign' } });
  const sourceB = await prisma.source.create({ data: { name: 'University Career Fair' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/sources');
    await expect(page.getByText('LinkedIn Campaign')).toBeVisible();
    await expect(page.getByText('University Career Fair')).toBeVisible();

    await page.fill('input[type="search"]', 'linkedin');
    await expect(page.getByText('LinkedIn Campaign')).toBeVisible();
    await expect(page.getByText('University Career Fair')).toHaveCount(0);
  } finally {
    await prisma.source.deleteMany({ where: { id: { in: [sourceA.id, sourceB.id] } } });
    await cleanupByEmail(adminEmail);
  }
});
