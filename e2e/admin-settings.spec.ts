import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('admin saves system settings and bulk-imports mentees from CSV', async ({ page }) => {
  const adminEmail = uniqueEmail('set-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Set Admin');
  const tag = Date.now();
  const importedA = `imp-a-${tag}@example.com`;
  const importedB = `imp-b-${tag}@example.com`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // Save settings.
    const put = await page.request.put('/api/admin/settings', { data: { reminderDays: '21', supportEmail: 'help@example.com', weeklyDigest: 'false' } });
    expect(put.ok()).toBeTruthy();
    const got = await (await page.request.get('/api/admin/settings')).json();
    expect(got.settings.reminderDays).toBe('21');
    expect(got.settings.weeklyDigest).toBe('false');

    // Bulk import two mentees (with a header row + one duplicate of admin to skip).
    const csv = `fullName,email,phone,university,department\nImported A,${importedA},,Uni,CS\nImported B,${importedB},,Uni,EE\nDup,${adminEmail},,,`;
    const imp = await page.request.post('/api/admin/import', { data: { csv } });
    expect(imp.status()).toBe(200);
    const res = await imp.json();
    expect(res.created).toBe(2);
    expect(res.skipped).toBe(1);

    // The imported mentees exist as MENTEE accounts.
    const a = await prisma.user.findUnique({ where: { email: importedA } });
    expect(a?.role).toBe('MENTEE');
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: [importedA, importedB] } } });
    await prisma.setting.deleteMany({ where: { key: { in: ['reminderDays', 'supportEmail', 'weeklyDigest'] } } });
    await cleanupByEmail(adminEmail);
  }
});
