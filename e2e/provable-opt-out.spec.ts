import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser, gotoSettled, signInViaApi } from './helpers/auth';

// Provable opt-out (#2054): a bulk send leaves a row for every intended
// recipient — the opted-out one included, as SKIPPED with the reason — and a
// super admin can show it, by group and by address. Not @smoke: it exercises a
// broadcast end to end.

const PW = 'OptOutProof123!';

test('an announcement honours an opt-out and leaves the proof; the super admin finds it by address', async ({ page, playwright }, info) => {
  const stamp = Date.now();
  const org = await prisma.organization.create({ data: { name: `Opt-out Org ${stamp}`, slug: `optout-${stamp}` } });
  const adminEmail = uniqueEmail('optout-admin');
  const keenEmail = uniqueEmail('optout-keen');
  const optedOutEmail = uniqueEmail('optout-quiet');
  const superEmail = uniqueEmail('optout-super');
  await seedUser(adminEmail, PW, 'ADMIN', 'Opt-out Admin', org.id);
  await seedUser(keenEmail, PW, 'MENTEE', 'Keen Mentee', org.id);
  const quiet = await seedUser(optedOutEmail, PW, 'MENTEE', 'Quiet Mentee', org.id);
  await prisma.user.update({ where: { id: quiet.id }, data: { notificationPrefs: { 'email:announcements': false } } });
  const sup = await seedUser(superEmail, PW, 'ADMIN', 'Opt-out Super');
  await prisma.user.update({ where: { id: sup.id }, data: { isSuperAdmin: true } });

  const admin = await playwright.request.newContext({ baseURL: info.project.use.baseURL });
  try {
    expect((await signInViaApi(admin, adminEmail, PW)).ok).toBe(true);
    const res = await admin.post('/api/admin/announcements', { data: { text: `Workshop on Thursday ${stamp}`, email: true } });
    expect(res.status(), await res.text()).toBe(201);
    const body = await res.json();
    // `emailed` still counts mail that was handed to the transport; the
    // honoured opt-out is counted beside it, not inside it.
    expect(body.skipped).toBe(1);

    // The opted-out recipient has a row: SKIPPED, with the group as the reason.
    const quietRows = await prisma.emailLog.findMany({ where: { to: optedOutEmail, category: 'announcement' } });
    expect(quietRows).toHaveLength(1);
    expect(quietRows[0]).toMatchObject({ status: 'SKIPPED', error: 'Unsubscribed: announcements' });
    // …and so does the one who wanted it (SENT, or SKIPPED for a missing SMTP in CI — never nothing).
    const keenRows = await prisma.emailLog.findMany({ where: { to: keenEmail, category: 'announcement' } });
    expect(keenRows).toHaveLength(1);
    expect(keenRows[0].error ?? '').not.toMatch(/^Unsubscribed:/);

    // The super admin's proof: the address lookup and the breakdown.
    await signInAsFreshUser(page, superEmail, PW, '/admin');
    const proof = await (await page.request.get(`/api/admin/email-log?suppressed=1&days=1&to=${encodeURIComponent(optedOutEmail)}`)).json();
    expect(proof.entries.map((e: { to: string; error: string }) => [e.to, e.error])).toEqual([[optedOutEmail, 'Unsubscribed: announcements']]);
    expect(proof.suppression.byGroup.find((g: { group: string }) => g.group === 'announcements')?.count).toBeGreaterThanOrEqual(1);
    // The lookup of an address that opted out of nothing finds nothing.
    expect((await (await page.request.get(`/api/admin/email-log?suppressed=1&to=${encodeURIComponent(keenEmail)}`)).json()).entries).toEqual([]);

    await gotoSettled(page, '/admin/settings');
    const panel = page.locator('[data-testid=email-optout-proof]:visible');
    await expect(panel.getByTestId('email-optout-total')).toBeVisible({ timeout: 20_000 });
    await panel.getByTestId('email-optout-address').fill(optedOutEmail);
    await panel.getByTestId('email-optout-lookup').click();
    await expect(panel.getByTestId('email-optout-entry')).toHaveCount(1);
    await expect(panel.getByTestId('email-optout-entry')).toContainText('Unsubscribed: announcements');
  } finally {
    await admin.dispose();
    await prisma.emailLog.deleteMany({ where: { to: { in: [keenEmail, optedOutEmail] } } });
    await prisma.notification.deleteMany({ where: { user: { orgId: org.id } } }).catch(() => {});
    await prisma.announcement.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    for (const e of [adminEmail, keenEmail, optedOutEmail, superEmail]) await cleanupByEmail(e);
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
});
