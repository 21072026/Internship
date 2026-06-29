import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can rename and delete a cohort', async ({ page }) => {
  const adminEmail = uniqueEmail('ce-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'CE Admin');
  const cohort = await prisma.cohort.create({ data: { name: `Cohort ${Date.now()}`, term: '2026' } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Rename via API (the UI uses a prompt()).
    const renamed = await page.request.patch(`/api/cohorts/${cohort.id}`, { data: { name: 'Renamed Cohort' } });
    expect(renamed.ok()).toBeTruthy();
    expect((await renamed.json()).cohort.name).toBe('Renamed Cohort');

    // Delete.
    const del = await page.request.delete(`/api/cohorts/${cohort.id}`);
    expect(del.ok()).toBeTruthy();
    const gone = await prisma.cohort.findUnique({ where: { id: cohort.id } });
    expect(gone).toBeNull();
  } finally {
    await prisma.cohort.deleteMany({ where: { id: cohort.id } });
    await cleanupByEmail(adminEmail);
  }
});
