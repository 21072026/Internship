import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// #2635: the outbound delivery log holds every tenant's recipients and
// subjects. A tenant admin used to read all of them from /admin/settings. Only
// a super admin may now, and only its own world's rows (the row's orgId).
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
  // Per world since super admin is (docs/worlds.md § Super admin): the log shows
  // mail to addresses that hold an account in the operator's world, so the
  // recipient is a user of an INTERNSHIP org — and a MARKETING user's row is
  // the other world's operator's, never this one's.
  const otherOrg = await prisma.organization.create({ data: { name: `Email Log Other ${stamp}`, slug: `elog-other-${stamp}` } });
  const mktOrg = await prisma.organization.create({ data: { name: `Email Log Mkt ${stamp}`, slug: `elog-mkt-${stamp}`, vertical: 'MARKETING' } });
  await seedUser(otherTenantRecipient, pw, 'MENTEE', 'Other Tenant User', otherOrg.id);
  const marketingRecipient = uniqueEmail('elog-marketing-user');
  await seedUser(marketingRecipient, pw, 'MENTEE', 'Marketing User', mktOrg.id);
  const row = await prisma.emailLog.create({
    data: { to: otherTenantRecipient, subject: `Private subject ${stamp}`, category: 'message', status: 'SENT' },
  });
  const mktRow = await prisma.emailLog.create({
    data: { to: marketingRecipient, subject: `Marketing subject ${stamp}`, category: 'message', status: 'SENT' },
  });
  // One mailbox, an account in each world: its mail belongs to the world of the
  // account it went to (the row's orgId), not to every world the address is in.
  const bothWorlds = uniqueEmail('elog-both-worlds');
  await seedUser(bothWorlds, pw, 'MENTOR', 'Both Worlds Intern', otherOrg.id);
  await seedUser(bothWorlds, pw, 'MENTOR', 'Both Worlds Rep', mktOrg.id);
  const [bothIntern, bothMkt, bothUnknown] = await Promise.all([
    prisma.emailLog.create({ data: { orgId: otherOrg.id, to: bothWorlds, subject: `Intern reminder ${stamp}`, category: 'interaction-reminder', status: 'SENT' } }),
    prisma.emailLog.create({ data: { orgId: mktOrg.id, to: bothWorlds, subject: `Rep reminder ${stamp}`, category: 'interaction-reminder', status: 'SENT' } }),
    // No orgId and an address in both worlds: whose it was cannot be told.
    prisma.emailLog.create({ data: { to: bothWorlds, subject: `Unattributed ${stamp}`, category: 'message', status: 'SENT' } }),
  ]);

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
    // The other world's mail is not this operator's.
    expect(body.entries.some((e) => e.id === mktRow.id)).toBe(false);
    // The two-world mailbox: only the row sent to its internship account.
    const ids = new Set(body.entries.map((e) => e.id));
    expect(ids.has(bothIntern.id)).toBe(true);
    expect(ids.has(bothMkt.id)).toBe(false);
    expect(ids.has(bothUnknown.id)).toBe(false);

    await gotoSettled(page, '/admin/settings');
    await expect(page.getByTestId('email-log-section')).toBeVisible({ timeout: 20_000 });
  } finally {
    await prisma.emailLog.deleteMany({ where: { id: { in: [row.id, mktRow.id, bothIntern.id, bothMkt.id, bothUnknown.id] } } });
    await cleanupByEmail(bothWorlds);
    await cleanupByEmail(tenantAdminEmail);
    await cleanupByEmail(otherTenantRecipient);
    await cleanupByEmail(marketingRecipient);
    await cleanupByEmail(superAdminEmail);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id, mktOrg.id] } } }).catch(() => {});
  }
});
