import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Inviting someone who has no account here (#1430). The whole point of the
// feature is that the outsider needs nothing — no login, no sign-up — so every
// assertion below is made with the browser's cookies cleared.

test('a mentor invites an outsider by email and they RSVP with no account', { tag: '@smoke' }, async ({ page }) => {
  const mentorEmail = uniqueEmail('guestmentor');
  const menteeEmail = uniqueEmail('guestmentee');
  // Deliberately NOT an @e2e.local seeded user — this address belongs to nobody.
  const guestEmail = uniqueEmail('outsider').replace('@e2e.local', '@external.example');

  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Guest Host');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Guest Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123!', '/mentor');
    await page.goto('/mentor/meetings');
    await page.getByText('Guest Mentee').click(); // toggles the recipient checkbox
    await page.getByLabel('Title').fill('Client intro');
    await page.getByLabel('Date', { exact: true }).fill('2026-09-01');
    await page.getByLabel('Time', { exact: true }).fill('14:00');

    // The outsider goes in as a chip, so the organizer sees who is about to be
    // mailed before anything is sent.
    await page.getByTestId('guest-email-input').fill(guestEmail);
    await page.getByTestId('guest-email-input').press('Enter');
    await expect(page.getByTestId(`guest-chip-${guestEmail}`)).toBeVisible();

    const scheduled = page.waitForResponse(
      (r) => r.url().includes('/api/meetings') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: 'Send invite' }).click();
    await scheduled;
    await expect(page.getByText(/Invited 1 outside guest/)).toBeVisible({ timeout: 10_000 });

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });
    expect(meeting).not.toBeNull();

    // Exactly one guest row, on the meeting, still unanswered.
    const guest = await prisma.meetingGuest.findFirst({ where: { meetingId: meeting!.id } });
    expect(guest).not.toBeNull();
    expect(guest!.email).toBe(guestEmail.toLowerCase());
    expect(guest!.rsvp).toBe('PENDING');
    // The token is a credential of its own, never the meeting's.
    expect(guest!.rsvpToken).not.toBe(meeting!.rsvpToken);

    // An invitation was actually addressed to them. EmailLog gets a row even
    // with no SMTP configured (status SKIPPED), which is what makes this
    // assertable offline.
    const logged = await prisma.emailLog.findFirst({
      where: { to: guestEmail.toLowerCase(), category: 'meeting-guest-invite' },
    });
    expect(logged).not.toBeNull();

    // …and now the outsider's side: no session, no account.
    await page.context().clearCookies();
    await page.goto(`/rsvp/${guest!.rsvpToken}`);
    await expect(page.getByText('Client intro')).toBeVisible({ timeout: 15_000 });

    const responded = page.waitForResponse(
      (r) => r.url().includes('/api/rsvp') && r.request().method() === 'POST'
    );
    await page.getByRole('button', { name: /Yes, I'll attend/ }).click();
    await responded;
    await expect(page.getByText(/attendance is confirmed/i)).toBeVisible({ timeout: 10_000 });

    const answered = await prisma.meetingGuest.findUnique({ where: { id: guest!.id } });
    expect(answered!.rsvp).toBe('ACCEPTED');
    expect(answered!.respondedAt).not.toBeNull();

    // The guest's answer is theirs alone — it must not be written onto the
    // meeting row, which carries the mentee's own (still unanswered) RSVP.
    const meetingAfter = await prisma.meeting.findUnique({ where: { id: meeting!.id } });
    expect(meetingAfter!.rsvp).toBe('PENDING');

    // The .ics works on the guest token too — with no account, it is the only
    // way the meeting reaches their calendar.
    const ics = await page.request.get(`/api/calendar/${guest!.rsvpToken}`);
    expect(ics.ok()).toBeTruthy();
    expect(await ics.text()).toContain('BEGIN:VCALENDAR');

    // The organizer is told who answered, by name.
    const notif = await prisma.notification.findFirst({
      where: { userId: mentor.id, type: 'guestRsvp.accepted' },
    });
    expect(notif).not.toBeNull();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.emailLog.deleteMany({ where: { to: guestEmail.toLowerCase() } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('an address that already has an account is invited as a member, not minted a guest token', async ({ page }) => {
  const mentorEmail = uniqueEmail('memmentor');
  const menteeEmail = uniqueEmail('memmentee');
  const otherEmail = uniqueEmail('colleague');

  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Member Host');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Member Mentee');
  await seedUser(otherEmail, 'OtherPass123!', 'MENTOR', 'Existing Colleague');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123!', '/mentor');

    // Straight at the API: a guest row is an unauthenticated way into the
    // meeting, so "never mint one against an account holder's address" is a
    // property of the endpoint, not of the form that happens to call it.
    const res = await page.request.post('/api/meetings', {
      data: {
        relationIds: [rel.id],
        title: 'Colleague check',
        scheduledAt: '2026-09-02T12:00:00.000Z',
        guests: [{ email: otherEmail }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.guestsInvited).toBe(0);
    expect(body.rejectedAsMembers).toContain(otherEmail.toLowerCase());

    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });
    expect(await prisma.meetingGuest.count({ where: { meetingId: meeting!.id } })).toBe(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await cleanupByEmail(otherEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a withdrawn guest invitation stops working', async ({ page }) => {
  const mentorEmail = uniqueEmail('revokementor');
  const menteeEmail = uniqueEmail('revokementee');
  const guestEmail = uniqueEmail('revoked').replace('@e2e.local', '@external.example');

  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Revoke Host');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Revoke Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123!', '/mentor');

    const created = await page.request.post('/api/meetings', {
      data: { relationIds: [rel.id], title: 'Revoke me', scheduledAt: '2026-09-03T09:00:00.000Z' },
    });
    expect(created.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirst({ where: { relationId: rel.id } });

    // Added after the fact — the "I forgot someone" half of the feature.
    const added = await page.request.post(`/api/meetings/${meeting!.id}/guests`, {
      data: { guests: [{ email: guestEmail, name: 'Late Addition' }] },
    });
    expect(added.status()).toBe(201);
    const guest = await prisma.meetingGuest.findFirstOrThrow({ where: { meetingId: meeting!.id } });
    expect(guest.name).toBe('Late Addition');

    // The token works…
    const before = await page.request.get(`/api/rsvp?token=${guest.rsvpToken}`);
    expect(before.ok()).toBeTruthy();

    // …until the invitation is withdrawn, at which point it must stop being a
    // way in — not merely stop appearing in the organizer's list.
    const removed = await page.request.delete(`/api/meetings/${meeting!.id}/guests`, {
      data: { guestId: guest.id },
    });
    expect(removed.ok()).toBeTruthy();

    const after = await page.request.get(`/api/rsvp?token=${guest.rsvpToken}`);
    expect(after.status()).toBe(404);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await prisma.emailLog.deleteMany({ where: { to: guestEmail.toLowerCase() } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});
