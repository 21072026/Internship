import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2635: the outbound delivery log is installation-wide — EmailLog has no
// orgId, so every row is some tenant's recipient and subject. A tenant admin
// used to read all of them from /admin/settings. Only a super admin may now.
test('the delivery log is the super admin\'s: a tenant admin gets 403 and no section', async ({ page }) => {
  const stamp = Date.now();
  const tenantAdminEmail = uniqueEmail('elog-tenant-admin');
  const superAdminEmail = uniqueEmail('elog-super-admin');
  const otherTenantRecipient = uniqueEmail('elog-other-tenant-user');
  const pw = 'AdminPass123';

  const org = await prisma.organization.create({ data: { name: `Email Log Org ${stamp}`, slug: `elog-${stamp}` } });
  await seedUser(tenantAdminEmail, pw, 'ADMIN', 'Tenant Admin', org.id);
  const superAdmin = await seedUser(superAdminEmail, pw, 'ADMIN', 'Super Admin');
  await prisma.user.update({ where: { id: superAdmin.id }, data: { isSuperAdmin: true } });
  // A mail another tenant's user received — exactly the row that leaked.
  const row = await prisma.emailLog.create({
    data: { to: otherTenantRecipient, subject: `Private subject ${stamp}`, category: 'message', status: 'SENT' },
  });

  try {
    await signInAsFreshUser(page, tenantAdminEmail, pw, '/admin');
    const denied = await page.request.get('/api/admin/email-log?limit=200');
    expect(denied.status()).toBe(403);
    expect(await denied.text()).not.toContain(otherTenantRecipient);

    await gotoSettled(page, '/admin/settings');
    await expect(page.getByTestId('settings-form')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(page.getByTestId('email-log-section')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(otherTenantRecipient);

    // The operator keeps the view.
    await signInAsFreshUser(page, superAdminEmail, pw, '/admin');
    const allowed = await page.request.get('/api/admin/email-log?limit=200');
    expect(allowed.ok()).toBeTruthy();
    const body = (await allowed.json()) as { entries: { id: string; to: string }[] };
    expect(body.entries.some((e) => e.id === row.id && e.to === otherTenantRecipient)).toBe(true);

    await gotoSettled(page, '/admin/settings');
    await expect(page.getByTestId('email-log-section')).toBeVisible({ timeout: 20_000 });
  } finally {
    await prisma.emailLog.deleteMany({ where: { id: row.id } });
    await cleanupByEmail(tenantAdminEmail);
    await cleanupByEmail(superAdminEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
