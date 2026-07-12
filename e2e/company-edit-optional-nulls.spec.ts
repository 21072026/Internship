import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #569: editing a company whose optional columns are NULL in the DB (size,
// logoUrl, address, description, contactEmail) used to fail zod validation with
// "Expected string, received null" and block saving. The form now accepts null
// and normalizes it, so the edit opens clean and saves.
test('a company with empty optional fields edits and saves without a null validation error', async ({ page }) => {
  const adminEmail = uniqueEmail('co-edit-admin');
  const pw = 'CoEditPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Company Edit Admin');
  // Only a name — every optional column stays NULL in the DB.
  const company = await prisma.company.create({ data: { name: `NullFields Co ${Date.now()}` } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/companies');
    await page.getByTestId(`edit-company-${company.id}`).click();

    // Edit form opens with the name pre-filled; no null-validation error shows.
    await expect(page.getByRole('button', { name: 'Update Company' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('received null')).toHaveCount(0);

    // Saving succeeds (PUT returns 2xx).
    const done = page.waitForResponse(
      (r) => r.url().includes(`/api/companies/${company.id}`) && r.request().method() === 'PUT',
      { timeout: 20_000 }
    );
    await page.getByRole('button', { name: 'Update Company' }).click();
    const res = await done;
    expect(res.ok()).toBeTruthy();
  } finally {
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
