import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #570: deactivated ("archived") accounts drop out of the default Users view and
// are reachable under the "Archived" tab, where they can be reactivated.
test('deactivated users are hidden by default and shown under the Archived tab', async ({ page }) => {
  const adminEmail = uniqueEmail('arch-admin');
  const inactiveEmail = uniqueEmail('arch-inactive');
  const pw = 'ArchivePass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Archive Admin');
  const inactive = await seedUser(inactiveEmail, 'x', 'MENTOR', 'Archived Mentor');
  await prisma.user.update({ where: { id: inactive.id }, data: { isActive: false } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    // Narrow the list to just this user.
    await page.getByPlaceholder('Search by name or email...').fill(inactiveEmail);

    // Default (Active) view: the deactivated user is not shown.
    await expect(page.getByTestId(`user-row-${inactive.id}`)).toHaveCount(0);

    // Archived view: it appears and can be reactivated.
    await page.getByTestId('status-view-archived').click();
    const row = page.getByTestId(`user-row-${inactive.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const patched = page.waitForResponse(
      (r) => r.url().includes(`/api/users/${inactive.id}`) && r.request().method() === 'PATCH'
    );
    await row.getByRole('button', { name: 'Activate' }).click();
    await patched;

    await expect
      .poll(async () => (await prisma.user.findUnique({ where: { id: inactive.id } }))!.isActive, { timeout: 10_000 })
      .toBe(true);
  } finally {
    await cleanupByEmail(inactiveEmail);
    await cleanupByEmail(adminEmail);
  }
});
