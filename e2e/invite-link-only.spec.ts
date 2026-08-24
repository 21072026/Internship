import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// #670 — invitations without an address.
//
// A mentor mints a link, hands it over, and whoever registers with it is their
// mentee. The three things worth pinning down: the link exists at all without an
// email, it auto-assigns on registration, and it cannot be turned into a
// privilege escalation by a mentor asking for an ADMIN invite.

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('a mentor mints an email-less invite link; whoever registers with it becomes their mentee', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('linkinv-mentor');
  const mentor = await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Link Invite Mentor');
  const inviteeEmail = uniqueEmail('linkinv-invitee');
  let inviteId = '';

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');

    // No email at all — just a note to remember who the link is for.
    const created = await page.request.post('/api/invite', {
      data: { role: 'MENTEE', label: 'Career fair, table 4' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    inviteId = body.invitationId;
    expect(body.registerUrl).toContain('/auth/register?token=');
    expect(body.emailSent).toBe(false);

    const row = await prisma.invitationToken.findUnique({ where: { id: inviteId } });
    expect(row?.email).toBeNull();
    expect(row?.label).toBe('Career fair, table 4');
    // The mentorship is pre-wired to the inviting mentor, server-side.
    expect(row?.mentorId).toBe(mentor.id);

    // The mentor's own list hands the link back — an email-less invite has no
    // other delivery path, so losing the tab must not strand the token.
    const list = await (await page.request.get('/api/invite')).json();
    const listed = list.invitations.find((i: { id: string }) => i.id === inviteId);
    expect(listed.label).toBe('Career fair, table 4');
    expect(listed.registerUrl).toContain('/auth/register?token=');

    // Register through it with an address the invitation never knew about.
    const registered = await page.request.post('/api/register', {
      data: {
        token: row!.token,
        email: inviteeEmail,
        password: 'Passw0rd!23',
        fullName: 'Link Invitee',
        consent: true,
      },
    });
    expect(registered.status()).toBe(201);

    const invitee = await prisma.user.findUnique({ where: { email: inviteeEmail } });
    expect(invitee?.role).toBe('MENTEE');
    expect(invitee?.isActive).toBe(true);
    // The address was typed in, not proven by receiving the invitation, so it
    // still has to be confirmed.
    expect(invitee?.emailVerified).toBe(false);

    const relation = await prisma.mentorshipRelation.findFirst({
      where: { mentorId: mentor.id, menteeId: invitee!.id },
    });
    expect(relation).not.toBeNull();

    // The consumed link now names who walked through it.
    const used = await prisma.invitationToken.findUnique({ where: { id: inviteId } });
    expect(used?.used).toBe(true);
    expect(used?.email).toBe(inviteeEmail);
    expect(used?.label).toBe('Career fair, table 4');
  } finally {
    if (inviteId) await prisma.invitationToken.deleteMany({ where: { id: inviteId } });
    await cleanupByEmail(inviteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a mentor cannot mint an admin invite link', async ({ page }) => {
  const mentorEmail = uniqueEmail('linkinv-esc-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Link Invite Escalation');
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    const res = await page.request.post('/api/invite', { data: { role: 'ADMIN', label: 'nice try' } });
    expect(res.status()).toBe(403);
  } finally {
    await cleanupByEmail(mentorEmail);
  }
});

test('the mentor invite page creates a link and shows it', async ({ page }) => {
  test.slow();
  const mentorEmail = uniqueEmail('linkinv-ui-mentor');
  await seedUser(mentorEmail, 'MentorPass123', 'MENTOR', 'Link Invite UI');
  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123', '/mentor');
    await page.goto('/mentor/invite');
    await page.getByTestId('mentor-invite-label').fill('Meetup, Ankara');
    await page.getByTestId('mentor-invite-submit').click();
    await expect(page.getByTestId('mentor-invite-success')).toBeVisible({ timeout: 15_000 });
    const link = page.getByTestId('mentor-invite-list').locator('input[readonly]').first();
    await expect(link).toHaveValue(/\/auth\/register\?token=/);
  } finally {
    await prisma.invitationToken.deleteMany({ where: { label: 'Meetup, Ankara' } });
    await cleanupByEmail(mentorEmail);
  }
});
