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
  const base = `/api/admin/companies/${company.id}/entitlements`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Free core: a brand-new company has no premium features enabled by default.
    const initial = await page.request.get(base);
    expect(initial.ok()).toBeTruthy();
    const initialFeatures = (await initial.json()).features as Record<string, boolean>;
    expect(Object.values(initialFeatures).some(Boolean)).toBe(false);
    expect(await prisma.companyEntitlement.count({ where: { companyId: company.id } })).toBe(0);

    // Admin enables one feature (the request the toggle UI makes).
    const enable = await page.request.put(base, { data: { feature: 'TALENT_POOL_SEARCH', enabled: true } });
    expect(enable.ok()).toBeTruthy();
    expect((await enable.json()).features.TALENT_POOL_SEARCH).toBe(true);
    await expect
      .poll(async () => prisma.companyEntitlement.count({ where: { companyId: company.id, feature: 'TALENT_POOL_SEARCH' } }), { timeout: 10_000 })
      .toBe(1);

    // An unknown feature key is rejected (400) — the catalogue is enforced.
    const bad = await page.request.put(base, { data: { feature: 'NOT_A_FEATURE', enabled: true } });
    expect(bad.status()).toBe(400);

    // Disabling removes the entitlement again.
    const disable = await page.request.put(base, { data: { feature: 'TALENT_POOL_SEARCH', enabled: false } });
    expect(disable.ok()).toBeTruthy();
    await expect
      .poll(async () => prisma.companyEntitlement.count({ where: { companyId: company.id } }), { timeout: 10_000 })
      .toBe(0);
  } finally {
    await prisma.companyEntitlement.deleteMany({ where: { companyId: company.id } });
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
