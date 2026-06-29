import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('impersonation records a reason and notifies the impersonated user', async ({ page }) => {
  const adminEmail = uniqueEmail('ig-admin');
  const targetEmail = uniqueEmail('ig-target');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'IG Admin');
  const target = await seedUser(targetEmail, 'x', 'MENTEE', 'IG Target');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/admin/impersonate', {
      data: { targetUserId: target.id, reason: 'support investigation' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).grant).toBeTruthy();

    // The impersonated user got a transparency notification.
    const notif = await prisma.notification.findFirst({ where: { userId: target.id, type: 'impersonation' } });
    expect(notif).toBeTruthy();
    expect(notif?.text).toContain('support investigation');
  } finally {
    await prisma.notification.deleteMany({ where: { userId: target.id } });
    await cleanupByEmail(targetEmail);
    await cleanupByEmail(adminEmail);
  }
});
