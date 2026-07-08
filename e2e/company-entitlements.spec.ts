import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin toggles a company premium feature; nothing is enabled by default (free core preserved)', async ({ page }) => {
  const adminEmail = uniqueEmail('ent-admin');
  const pw = 'EntAdminPass123';
  await seedUser(adminEmail, pw, 'ADMIN', 'Entitlement Admin');
  const company = await prisma.company.create({ data: { name: `Entitle Co ${Date.now()}` } });

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Free core: a brand-new company has no premium entitlements.
    expect(await prisma.companyEntitlement.count({ where: { companyId: company.id } })).toBe(0);

    await page.goto('/admin/companies');
    // Narrow to just this company, then open its premium modal.
    await page.getByPlaceholder(/Search/i).fill(company.name);
    await page.getByRole('button', { name: 'Premium features' }).click();

    // Enable one feature via the toggle.
    await page.getByText('Talent pool search & filters').click();
    const done = page.waitForResponse(
      (r) => r.url().includes(`/api/admin/companies/${company.id}/entitlements`) && r.request().method() === 'PUT',
      { timeout: 20_000 }
    );
    const res = await done;
    expect(res.ok()).toBeTruthy();

    await expect
      .poll(async () => prisma.companyEntitlement.count({ where: { companyId: company.id, feature: 'TALENT_POOL_SEARCH' } }), { timeout: 10_000 })
      .toBe(1);

    // Toggling off removes it again.
    await page.getByText('Talent pool search & filters').click();
    await expect
      .poll(async () => prisma.companyEntitlement.count({ where: { companyId: company.id } }), { timeout: 10_000 })
      .toBe(0);
  } finally {
    await prisma.companyEntitlement.deleteMany({ where: { companyId: company.id } });
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
