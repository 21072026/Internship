import { test, expect } from '@playwright/test';
import { gotoSettled } from './helpers/auth';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('global search finds a mentee and saved views can be created', async ({ page }) => {
  const adminEmail = uniqueEmail('srchadmin');
  const menteeEmail = uniqueEmail('srchmentee');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Search Admin');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Zephyrine Quanta');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Global search API returns the mentee.
    const res = await page.request.get('/api/search?q=Zephyrine');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect((data.users ?? []).some((u: { id: string }) => u.id === mentee.id)).toBeTruthy();

    // Saved views: create one on the candidates page.
    await gotoSettled(page, '/admin/candidates');
    // Saving opens an inline name form (not window.prompt) since #1900.
    await page.getByTestId('saved-views-save').click();
    await page.getByTestId('saved-views-name').fill('My View');
    await page.getByTestId('saved-views-confirm').click();
    await expect(page.getByRole('button', { name: 'My View', exact: true })).toBeVisible({ timeout: 10_000 });
  } finally {
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
