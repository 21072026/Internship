import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin can bulk-deactivate and bulk-reactivate selected candidates', async ({ page }) => {
  const adminEmail = uniqueEmail('bulk-admin');
  const menteeAEmail = uniqueEmail('bulk-mentee-a');
  const menteeBEmail = uniqueEmail('bulk-mentee-b');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Bulk Admin');
  const menteeA = await seedUser(menteeAEmail, 'x', 'MENTEE', 'Bulk Candidate A');
  const menteeB = await seedUser(menteeBEmail, 'x', 'MENTEE', 'Bulk Candidate B');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/candidates');
    await expect(page.getByText('Bulk Candidate A')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId(`candidate-card-${menteeA.id}`).getByRole('checkbox').check();
    await page.getByTestId(`candidate-card-${menteeB.id}`).getByRole('checkbox').check();

    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: /^Deactivate$/i }).click();

    await expect(async () => {
      const a = await prisma.user.findUnique({ where: { id: menteeA.id } });
      const b = await prisma.user.findUnique({ where: { id: menteeB.id } });
      expect(a?.isActive).toBe(false);
      expect(b?.isActive).toBe(false);
    }).toPass({ timeout: 10_000 });

    await expect(page.getByText('Inactive').first()).toBeVisible();

    // Reactivate one of them via the API directly (already exercised the UI path above).
    const bulkRes = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [menteeA.id], action: 'activate' },
    });
    expect(bulkRes.ok()).toBeTruthy();
    const afterReactivate = await prisma.user.findUnique({ where: { id: menteeA.id } });
    expect(afterReactivate?.isActive).toBe(true);

    // Safety: the endpoint never touches a non-MENTEE account even if targeted.
    const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
    const guardRes = await page.request.post('/api/admin/candidates/bulk', {
      data: { candidateIds: [adminUser!.id], action: 'deactivate' },
    });
    const guardBody = await guardRes.json();
    expect(guardBody.updated).toBe(0);
    const adminAfter = await prisma.user.findUnique({ where: { id: adminUser!.id } });
    expect(adminAfter?.isActive).toBe(true);
  } finally {
    await cleanupByEmail(menteeAEmail);
    await cleanupByEmail(menteeBEmail);
    await cleanupByEmail(adminEmail);
  }
});
