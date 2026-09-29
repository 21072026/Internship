import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('bulk import dry-run validates rows without creating users', async ({ page }) => {
  const adminEmail = uniqueEmail('dr-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'DR Admin');
  const tag = Date.now();
  const goodEmail = `dr-good-${tag}@example.com`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // One valid row, one invalid email, one duplicate of the admin.
    const csv = `fullName,email\nGood One,${goodEmail}\nBad,not-an-email\nDup,${adminEmail}`;
    const res = await page.request.post('/api/admin/import', { data: { csv, dryRun: true } });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.dryRun).toBe(true);
    expect(d.willCreate).toBe(1);
    expect(d.errors).toBe(1);
    expect(d.skipped).toBe(1);
    expect(d.rows).toHaveLength(3);

    // Nothing was actually created.
    const created = await prisma.user.findFirst({ where: { email: goodEmail } });
    expect(created).toBeNull();
  } finally {
    await prisma.user.deleteMany({ where: { email: goodEmail } });
    await cleanupByEmail(adminEmail);
  }
});
