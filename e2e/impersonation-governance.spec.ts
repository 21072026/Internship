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

test('impersonating another admin is rejected by the API', async ({ page }) => {
  const adminEmail = uniqueEmail('ig-admin2');
  const otherAdminEmail = uniqueEmail('ig-other-admin');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'IG Admin Two');
  const otherAdmin = await seedUser(otherAdminEmail, 'x', 'ADMIN', 'IG Other Admin');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    const res = await page.request.post('/api/admin/impersonate', {
      data: { targetUserId: otherAdmin.id },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('admin');
    const started = await prisma.auditLog.findFirst({
      where: { action: 'IMPERSONATE_START', targetId: otherAdmin.id },
    });
    expect(started).toBeNull();
  } finally {
    await cleanupByEmail(otherAdminEmail);
    await cleanupByEmail(adminEmail);
  }
});

test('a failed impersonation attempt shows an inline error and re-enables the button', async ({ page }) => {
  const adminEmail = uniqueEmail('ig-admin3');
  const otherAdminEmail = uniqueEmail('ig-other-admin2');
  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'IG Admin Three');
  const otherAdmin = await seedUser(otherAdminEmail, 'x', 'ADMIN', 'IG Other Admin Two');

  try {
    await page.goto('/auth/signin');
    await page.fill('input[type="email"], input[name="email"]', adminEmail);
    await page.fill('input[type="password"]', 'AdminPass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin'), { timeout: 20_000 });

    await page.goto('/admin/users');
    page.once('dialog', (d) => d.dismiss());
    const row = page.getByTestId(`user-row-${otherAdmin.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.getByRole('button', { name: 'Login as' }).click();

    await expect(row.getByText(/cannot impersonate an admin/i)).toBeVisible({ timeout: 10_000 });
    // The button resets to clickable rather than staying stuck disabled.
    await expect(row.getByRole('button', { name: 'Login as' })).toBeEnabled();
    // No session/route change happened.
    expect(page.url()).toContain('/admin/users');
  } finally {
    await cleanupByEmail(otherAdminEmail);
    await cleanupByEmail(adminEmail);
  }
});
