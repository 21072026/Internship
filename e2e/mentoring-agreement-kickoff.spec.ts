import { test, expect, type Browser } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAndSettle } from './helpers/auth';

// The mentoring agreement at kickoff (#1792). Its own org.
//   • an admin creates the pairing → both sides are prompted, both accept (the
//     mentee through the portal card), the admin list shows it SIGNED;
//   • accepting twice writes one row; an ADMIN cannot accept for anyone (403);
//     a superseded version is refused (409);
//   • and the rule most likely to be "fixed" into a gate later: an UNSIGNED
//     pair can still message, meet, set goals and use the portal.

const PW = 'Kickoff123!';

async function signedIn(browser: Browser, email: string, landing: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInAndSettle(page, email, PW, landing);
  return { ctx, page };
}

test.describe('mentoring agreement at kickoff', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('mk-admin');
  const mentor = uniqueEmail('mk-mentor');
  const mentee = uniqueEmail('mk-mentee');
  const mentee2 = uniqueEmail('mk-mentee2');
  let orgId = '';
  let mentorId = '';
  let menteeId = '';
  let mentee2Id = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `MK Org ${stamp}`, slug: `mk-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `MK Admin ${stamp}`, orgId);
    mentorId = (await seedUser(mentor, PW, 'MENTOR', `MK Mentor ${stamp}`, orgId)).id;
    menteeId = (await seedUser(mentee, PW, 'MENTEE', `MK Mentee ${stamp}`, orgId)).id;
    mentee2Id = (await seedUser(mentee2, PW, 'MENTEE', `MK Unsigned ${stamp}`, orgId)).id;
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: { in: [mentorId, menteeId, mentee2Id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    await prisma.mentoringAgreement.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, mentee, mentee2]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('create → both accept → the admin list shows it signed', async ({ browser }) => {
    test.slow();
    const asAdmin = await signedIn(browser, admin, '/admin');
    const created = await asAdmin.page.request.post('/api/mentorship', { data: { mentorId, menteeId } });
    expect(created.status()).toBe(201);
    const relationId = (await created.json()).relation.id as string;
    // Both sides are prompted.
    expect(await prisma.notification.count({ where: { userId: { in: [mentorId, menteeId] }, type: 'agreement.review' } })).toBe(2);

    // The admin reads the block but cannot accept on anyone's behalf.
    const adminView = await (await asAdmin.page.request.get(`/api/mentorship/${relationId}`)).json();
    expect(adminView.agreement).toMatchObject({ version: '1', status: 'UNSIGNED', seat: null });
    expect((await asAdmin.page.request.post(`/api/mentorship/${relationId}/agreement/accept`, { data: { version: '1' } })).status()).toBe(403);

    // The mentee accepts through the portal card, in their language.
    const asMentee = await signedIn(browser, mentee, '/portal');
    await gotoSettled(asMentee.page, '/portal');
    const card = asMentee.page.getByTestId('agreement-card');
    await expect(card).toHaveAttribute('data-state', 'pending', { timeout: 60_000 });
    await expect(card.getByTestId('agreement-text')).toContainText('Mentoring agreement');
    await expect(card.getByTestId('agreement-accept')).toBeDisabled();
    await card.getByTestId('agreement-checkbox').check();
    await card.getByTestId('agreement-accept').click();
    await expect(asMentee.page.getByTestId('agreement-card')).toHaveAttribute('data-state', 'accepted');

    // Accepting again returns the first row; a superseded version is refused.
    const again = await asMentee.page.request.post(`/api/mentorship/${relationId}/agreement/accept`, { data: { version: '1' } });
    expect(again.status()).toBe(201);
    expect(await prisma.mentoringAgreementAcceptance.count({ where: { relationId, userId: menteeId } })).toBe(1);
    expect((await (await asMentee.page.request.post(`/api/mentorship/${relationId}/agreement/accept`, { data: { version: '0' } })).json()).code).toBe('stale_version');
    const row = await prisma.mentoringAgreementAcceptance.findFirstOrThrow({ where: { relationId, userId: menteeId } });
    expect(row).toMatchObject({ role: 'MENTEE', version: '1' });
    expect(row.uaHash).toMatch(/^[0-9a-f]{32}$/);

    // The mentor accepts their side.
    const asMentor = await signedIn(browser, mentor, '/mentor');
    expect((await asMentor.page.request.post(`/api/mentorship/${relationId}/agreement/accept`, { data: { version: '1' } })).status()).toBe(201);

    // The admin list shows it signed, and filters by it.
    const signed = await (await asAdmin.page.request.get('/api/mentorship?page=1&agreement=SIGNED')).json();
    expect(signed.relations.map((r: { id: string }) => r.id)).toContain(relationId);
    const unsigned = await (await asAdmin.page.request.get('/api/mentorship?page=1&agreement=UNSIGNED')).json();
    expect(unsigned.relations.map((r: { id: string }) => r.id)).not.toContain(relationId);
    await gotoSettled(asAdmin.page, '/admin/mentorship');
    await expect(asAdmin.page.getByTestId(`mentorship-agreement-${relationId}`)).toHaveAttribute('data-status', 'SIGNED', { timeout: 60_000 });
    const report = await (await asAdmin.page.request.get('/api/admin/agreements/acceptances')).json();
    expect(report.relations.find((r: { relationId: string }) => r.relationId === relationId)).toMatchObject({ status: 'SIGNED' });

    for (const s of [asAdmin, asMentee, asMentor]) await s.ctx.close();
  });

  test('an unsigned pair keeps full access — the agreement is a prompt, never a gate', async ({ browser }) => {
    test.slow();
    const relationId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId: mentee2Id } })).id;
    expect(await prisma.mentoringAgreementAcceptance.count({ where: { relationId } })).toBe(0);

    const asMentee = await signedIn(browser, mentee2, '/portal');
    // The portal works and shows the prompt.
    const portal = await asMentee.page.goto('/portal');
    expect(portal?.status()).toBe(200);
    await expect(asMentee.page.getByTestId('agreement-card')).toHaveAttribute('data-state', 'pending', { timeout: 60_000 });
    // Messaging.
    const msg = await asMentee.page.request.post('/api/messages', { data: { relationId, body: 'Hello before signing' } });
    expect(msg.status(), await msg.text()).toBeLessThan(300);
    // Goals.
    const goal = await asMentee.page.request.post('/api/goals', { data: { relationId, title: 'A goal before signing' } });
    expect(goal.status(), await goal.text()).toBeLessThan(300);

    // Meetings, from the mentor's side.
    const asMentor = await signedIn(browser, mentor, '/mentor');
    const meeting = await asMentor.page.request.post('/api/meetings', { data: { relationIds: [relationId], title: 'Kickoff before signing' } });
    expect(meeting.status(), await meeting.text()).toBeLessThan(300);
    // The mentee detail page renders with the prompt, not a lock.
    await gotoSettled(asMentor.page, `/mentor/mentees/${relationId}`);
    await expect(asMentor.page.getByTestId('agreement-card')).toHaveAttribute('data-state', 'pending', { timeout: 60_000 });

    for (const s of [asMentee, asMentor]) await s.ctx.close();
  });
});
