import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { floodIp } from './helpers/rateLimit';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2433: "who read this customer record?" is answered from ActivityLog. A read
// of GET /api/companies/[id] writes a `company.view` entry, and a repeat of the
// same read inside `viewLogWindowMinutes` (default 15) writes no second one.
// The rule, failure paths included, is unit-tested in
// scripts/test/view-log-rule.test.mjs; this spec pins what only a real request
// can: that the route calls it, with the right key, and that the key's origin
// half is the address logActivity() stores.
//
// The window setting is deliberately NOT changed here: it is a global row, and
// flipping it would change the log for every spec sharing the server.
test('reading a company writes one company.view row per reader, origin and window', async ({ page }) => {
  const adminEmail = uniqueEmail('cva-admin');
  const pw = 'CvaAdminPass123';
  const admin = await seedUser(adminEmail, pw, 'ADMIN', 'CVA Admin');
  const company = await prisma.company.create({ data: { name: `CVA Co ${Date.now()}` } });
  const missingId = `cva-missing-${Date.now()}`;

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', pw);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    // One origin for the first two reads, so they are "the same read".
    const here = floodIp('company-view-a');
    const views = () => prisma.activityLog.findMany({
      where: { action: 'company.view', targetId: company.id },
      orderBy: { createdAt: 'asc' },
    });

    const first = await page.request.get(`/api/companies/${company.id}`, { headers: here });
    expect(first.status()).toBe(200);
    // logViewActivity() is awaited before the response goes out, so the row
    // exists by now; no polling needed.
    const afterFirst = await views();
    expect(afterFirst, 'the first read of a company is logged').toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({
      actorId: admin.id,
      actorEmail: adminEmail,
      targetType: 'company',
      targetId: company.id,
      detail: company.name,
      ip: here['X-Real-IP'],
    });

    const again = await page.request.get(`/api/companies/${company.id}`, { headers: here });
    expect(again.status()).toBe(200);
    expect(await views(), 'a repeat inside the window writes no second row').toHaveLength(1);

    // A read from another address is a different fact, and the one an incident
    // review asks about: it is never folded into the first.
    const elsewhere = floodIp('company-view-b');
    const other = await page.request.get(`/api/companies/${company.id}`, { headers: elsewhere });
    expect(other.status()).toBe(200);
    const afterOther = await views();
    expect(afterOther, 'a read from a new origin is its own row').toHaveLength(2);
    expect(afterOther[1].ip).toBe(elsewhere['X-Real-IP']);

    // A 404 read nothing, so it logs nothing.
    const missing = await page.request.get(`/api/companies/${missingId}`, { headers: here });
    expect(missing.status()).toBe(404);
    expect(await prisma.activityLog.count({ where: { action: 'company.view', targetId: missingId } })).toBe(0);
  } finally {
    await prisma.activityLog.deleteMany({ where: { action: 'company.view', targetId: { in: [company.id, missingId] } } });
    await prisma.company.delete({ where: { id: company.id } }).catch(() => {});
    await cleanupByEmail(adminEmail);
  }
});
