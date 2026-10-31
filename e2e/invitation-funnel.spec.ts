import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail, setOrgFeature } from './helpers/db';
import { gotoSettled, signInAndSettle, signInViaApi } from './helpers/auth';

// #1921 (slice 1): the invitation funnel — sent → opened → registered → signed
// in — on the invitation board, its API and the report registry. Counts and
// rates only: the response names no person. Its own org.
//
//   MENTEE  sent only · opened · opened · registered (no sign-in yet) · registered + signed in
//   MENTOR  registered + signed in
//   MENTEE  revoked before anyone used it — outside the funnel
//
// The not-yet-signed-in invitee's address also has an account in ANOTHER org
// that has signed in: it must not count, because "signed in" is read in the
// invitation's own org. Then that invitee signs in for real and the funnel
// moves.

const PW = 'InviteFunnel123!';
const DAY = 24 * 60 * 60 * 1000;

test('the invitation funnel counts in-app steps, per role, inside its own org', async ({ page }) => {
  test.slow();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const org = await prisma.organization.create({ data: { name: `Invite Funnel ${stamp}`, slug: `invite-funnel-${stamp}` } });
  const other = await prisma.organization.create({ data: { name: `Invite Funnel Other ${stamp}`, slug: `invite-funnel-other-${stamp}` } });
  try {
    const adminEmail = uniqueEmail('if-admin');
    const admin = await seedUser(adminEmail, PW, 'ADMIN', 'IF Admin', org.id);
    const now = new Date();
    const invite = (role: 'MENTEE' | 'MENTOR', email: string, extra: Record<string, unknown> = {}) =>
      prisma.invitationToken.create({
        data: { token: `if-${stamp}-${Math.random().toString(36).slice(2)}`, email, role, orgId: org.id, invitedById: admin.id, expiresAt: new Date(now.getTime() + 7 * DAY), ...extra },
      });

    await invite('MENTEE', uniqueEmail('if-sent'));
    await invite('MENTEE', uniqueEmail('if-opened'), { openedAt: now });
    await invite('MENTEE', uniqueEmail('if-opened2'), { openedAt: now });
    const waitingEmail = uniqueEmail('if-waiting');
    await invite('MENTEE', waitingEmail, { openedAt: now, registeredAt: now, used: true });
    await seedUser(waitingEmail, PW, 'MENTEE', 'IF Waiting', org.id);
    // The same address in another org, signed in there: not this invitation's account.
    const elsewhere = await seedUser(waitingEmail, PW, 'MENTEE', 'IF Elsewhere', other.id);
    await prisma.user.update({ where: { id: elsewhere.id }, data: { lastLoginAt: now } });
    const activeEmail = uniqueEmail('if-active');
    await invite('MENTEE', activeEmail, { openedAt: now, registeredAt: now, used: true });
    const active = await seedUser(activeEmail, PW, 'MENTEE', 'IF Active', org.id);
    await prisma.user.update({ where: { id: active.id }, data: { lastLoginAt: now } });
    const mentorEmail = uniqueEmail('if-mentor');
    await invite('MENTOR', mentorEmail, { registeredAt: now, used: true });
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'IF Mentor', org.id);
    await prisma.user.update({ where: { id: mentor.id }, data: { lastLoginAt: now } });
    await invite('MENTEE', uniqueEmail('if-revoked'), { revokedAt: now });

    await signInAndSettle(page, adminEmail, PW, '/admin');
    const funnel = async () => (await page.request.get('/api/admin/invitations/funnel')).json();

    const before = await funnel();
    expect(before.total).toEqual({ sent: 6, opened: 5, registered: 3, activated: 2 });
    expect(before.revoked).toBe(1);
    expect(before.byRole).toEqual([
      { role: 'MENTEE', sent: 5, opened: 4, registered: 2, activated: 1 },
      { role: 'MENTOR', sent: 1, opened: 1, registered: 1, activated: 1 },
    ]);
    expect(Object.keys(before).sort()).toEqual(['byRole', 'revoked', 'total']);
    expect(JSON.stringify(before)).not.toContain('@');
    // A range that ends before today holds none of them.
    const empty = await (await page.request.get('/api/admin/invitations/funnel?to=2020-01-01')).json();
    expect(empty.total).toEqual({ sent: 0, opened: 0, registered: 0, activated: 0 });

    // The board shows the same numbers.
    await gotoSettled(page, '/admin/invitations');
    const card = page.getByTestId('invitation-funnel');
    await expect(card.getByTestId('invitation-funnel-sent-count')).toHaveText('6');
    await expect(card.getByTestId('invitation-funnel-activated-count')).toHaveText('2');
    await expect(card.getByTestId('invitation-funnel-role-MENTEE-registered')).toHaveText('2');
    await expect(card.getByTestId('invitation-funnel-revoked')).toBeVisible();

    // The registry report: the MENTEE group as itself, the single MENTOR folded
    // into the privacy-floor bucket.
    await setOrgFeature(org.id, 'ADVANCED_ANALYTICS', true);
    const report = await (await page.request.get('/api/admin/reports/invitation-funnel')).json();
    expect(report.rows).toContainEqual({ role: 'Mentee', sent: 5, opened: 4, registered: 2, activated: 1, activation: 20 });
    expect(report.rows).toContainEqual(expect.objectContaining({ role: '__suppressed__', sent: 1 }));

    // The waiting invitee signs in for real: the funnel moves.
    expect((await signInViaApi(page.request, waitingEmail, PW)).ok).toBe(true);
    await expect
      .poll(async () => (await prisma.user.findFirst({ where: { email: waitingEmail, orgId: org.id }, select: { lastLoginAt: true } }))?.lastLoginAt ?? null)
      .not.toBeNull();
    expect((await signInViaApi(page.request, adminEmail, PW)).ok).toBe(true);
    expect((await funnel()).total).toEqual({ sent: 6, opened: 5, registered: 3, activated: 3 });
  } finally {
    await prisma.orgEntitlement.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.invitationToken.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: { in: [org.id, other.id] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, other.id] } } });
  }
});
