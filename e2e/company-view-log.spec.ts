import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * "Who read this customer record?" (#2433) — the same shape as
 * e2e/document-access-log.spec.ts, plus the half that is new here: repeat reads
 * by the same person inside the de-dup window must collapse into ONE row
 * (src/lib/companyViewLog.ts), or a table kept for a year fills with a row per
 * refetch.
 */
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('reading a company detail writes one company.view row per reader per window', async ({ page }) => {
  const adminEmail = uniqueEmail('cview-admin');
  const admin = await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'CView Admin');
  const company = await prisma.company.create({ data: { name: `CView Co ${Date.now()}` } });

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');

    const first = await page.request.get(`/api/companies/${company.id}`);
    expect(first.status()).toBe(200);

    await expect
      .poll(
        async () => prisma.activityLog.count({ where: { action: 'company.view', targetId: company.id } }),
        { timeout: 10_000 }
      )
      .toBe(1);

    const row = await prisma.activityLog.findFirst({ where: { action: 'company.view', targetId: company.id } });
    expect(row?.actorId, 'the reader is named').toBe(admin.id);
    expect(row?.targetType).toBe('Company');
    expect(row?.detail, 'the account is nameable after the row is pruned').toBe(company.name);

    // Three more reads in the same sitting. The write is awaited inside the
    // handler, so once these responses are back the count is final — no poll.
    for (let i = 0; i < 3; i++) {
      expect((await page.request.get(`/api/companies/${company.id}`)).status()).toBe(200);
    }
    expect(
      await prisma.activityLog.count({ where: { action: 'company.view', targetId: company.id } }),
      'repeat reads inside the window must not add rows'
    ).toBe(1);
  } finally {
    await prisma.activityLog.deleteMany({ where: { targetId: company.id } });
    await prisma.company.deleteMany({ where: { id: company.id } });
    await cleanupByEmail(adminEmail);
  }
});
