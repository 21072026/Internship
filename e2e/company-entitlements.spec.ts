import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// The per-company premium grid is READ-ONLY since #1734: a company's features
// come from its organisation (plan, or a super admin's grant on /admin/billing).
// The GET still answers where each feature comes from; the PUT that let any
// tenant admin switch a paid feature on for one company is gone.
test('the company feature map is read-only; nothing is enabled by default (free core preserved)', async ({ page }) => {
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
    const body = await initial.json();
    expect(Object.values(body.features as Record<string, boolean>).some(Boolean)).toBe(false);
    expect(body.sources.TALENT_POOL_SEARCH).toEqual({ enabled: false, fromPlan: false, override: false });

    // No write path any more: the toggle request is not accepted and writes nothing.
    const put = await page.request.put(base, { data: { feature: 'TALENT_POOL_SEARCH', enabled: true } });
    expect(put.status()).toBe(405);
    expect(await prisma.companyEntitlement.count({ where: { companyId: company.id } })).toBe(0);
  } finally {
    await prisma.companyEntitlement.deleteMany({ where: { companyId: company.id } });
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
