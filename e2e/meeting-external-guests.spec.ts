import { test, expect } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

test.afterAll(async () => {
  await prisma.$disconnect();
});

// Inviting someone who has no account here (#1446). The whole point of the
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
    // Tick the recipient's own checkbox, not their name: the name is a
    // PersonHoverCard, whose onClick preventDefault()s + stopPropagation()s
    // exactly so opening the card does not toggle the label it sits in.
    await page.locator('label', { hasText: 'Guest Mentee' }).getByRole('checkbox').check();
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

test('a bulk schedule invites an outside guest once, not once per mentee', async ({ page }) => {
  const mentorEmail = uniqueEmail('bulkmentor');
  const menteeAEmail = uniqueEmail('bulkmenteea');
  const menteeBEmail = uniqueEmail('bulkmenteeb');
  const guestEmail = uniqueEmail('bulkguest').replace('@e2e.local', '@external.example');

  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Bulk Host');
  const menteeA = await seedUser(menteeAEmail, 'x', 'MENTEE', 'Bulk Mentee A');
  const menteeB = await seedUser(menteeBEmail, 'x', 'MENTEE', 'Bulk Mentee B');
  const relA = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: menteeA.id } });
  const relB = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: menteeB.id } });

  try {
    await signInAndSettle(page, mentorEmail, 'MentorPass123!', '/mentor');

    const res = await page.request.post('/api/meetings', {
      data: {
        relationIds: [relA.id, relB.id],
        title: 'Bulk with a guest',
        scheduledAt: '2026-09-04T10:00:00.000Z',
        guests: [{ email: guestEmail }],
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Two meeting rows (one per relation, sharing a room) but ONE guest row and
    // ONE email — this is the whole reason guests hang off a single row.
    expect(body.created).toBe(2);
    expect(body.guestsInvited).toBe(1);
    expect(await prisma.meetingGuest.count({ where: { email: guestEmail.toLowerCase() } })).toBe(1);
    expect(
      await prisma.emailLog.count({
        where: { to: guestEmail.toLowerCase(), category: 'meeting-guest-invite' },
      })
    ).toBe(1);

    // …and that one row hangs off one of the two meetings, both of which share
    // the room the guest was actually invited to.
    const rows = await prisma.meeting.findMany({
      where: { relationId: { in: [relA.id, relB.id] } },
      include: { guests: true },
    });
    expect(rows.filter((m) => m.guests.length > 0)).toHaveLength(1);
    // Both rows share one room, which is why inviting the guest once is right.
    expect(new Set(rows.map((m) => m.meetLink)).size).toBe(1);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: { in: [relA.id, relB.id] } } });
    await prisma.emailLog.deleteMany({ where: { to: guestEmail.toLowerCase() } });
    await cleanupByEmail(menteeAEmail);
    await cleanupByEmail(menteeBEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('a mentee cannot invite outsiders, even to a meeting they are in', async ({ page }) => {
  const mentorEmail = uniqueEmail('gatementor');
  const menteeEmail = uniqueEmail('gatementee');
  const guestEmail = uniqueEmail('gateguest').replace('@e2e.local', '@external.example');

  const mentor = await seedUser(mentorEmail, 'MentorPass123!', 'MENTOR', 'Gate Host');
  const mentee = await seedUser(menteeEmail, 'MenteePass123!', 'MENTEE', 'Gate Mentee');
  const rel = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Gated',
      scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      // The mentee is the CREATOR here — which is reachable in the app via
      // /api/meetings/instant, and is exactly the case where "organizer" alone
      // would have been enough to let them mint guest tokens.
      createdById: mentee.id,
      rsvpToken: randomBytes(24).toString('hex'),
    },
  });

  try {
    await signInAndSettle(page, menteeEmail, 'MenteePass123!', '/portal');

    // 404, not 403: the id space stays opaque, same as /api/meetings/[id]/call-token.
    const post = await page.request.post(`/api/meetings/${meeting.id}/guests`, {
      data: { guests: [{ email: guestEmail }] },
    });
    expect(post.status()).toBe(404);
    const get = await page.request.get(`/api/meetings/${meeting.id}/guests`);
    expect(get.status()).toBe(404);

    expect(await prisma.meetingGuest.count({ where: { meetingId: meeting.id } })).toBe(0);
    expect(await prisma.emailLog.count({ where: { to: guestEmail.toLowerCase() } })).toBe(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: rel.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  }
});

test('the reminder cron reaches a guest, but not one who declined', async ({ page }) => {
  const adminEmail = uniqueEmail('remadmin');
  const mentorEmail = uniqueEmail('remmentor');
  const menteeEmail = uniqueEmail('remmentee');
  const comingEmail = uniqueEmail('coming').replace('@e2e.local', '@external.example');
  const declinedEmail = uniqueEmail('declined').replace('@e2e.local', '@external.example');

  await seedUser(adminEmail, 'AdminPass123', 'ADMIN', 'Reminder Admin');
  const mentor = await seedUser(mentorEmail, 'x', 'MENTOR', 'Reminder Mentor');
  const mentee = await seedUser(menteeEmail, 'x', 'MENTEE', 'Reminder Mentee');
  const rel = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const meeting = await prisma.meeting.create({
    data: {
      relationId: rel.id,
      title: 'Guest reminder',
      // Inside the 60-minute reminder window.
      scheduledAt: new Date(Date.now() + 30 * 60 * 1000),
      rsvpToken: randomBytes(24).toString('hex'),
      createdById: mentor.id,
      guests: {
        create: [
          { email: comingEmail, rsvpToken: randomBytes(24).toString('hex'), invitedById: mentor.id },
          {
            email: declinedEmail,
            rsvp: 'DECLINED',
            rsvpToken: randomBytes(24).toString('hex'),
            invitedById: mentor.id,
          },
        ],
      },
    },
  });

  try {
    await signInAndSettle(page, adminEmail, 'AdminPass123', '/admin');
    const res = await page.request.get('/api/cron');
    expect(res.ok()).toBeTruthy();

    // A guest has no dashboard and no in-app notification — the email is the
    // only nudge they can get, so it has to actually go out.
    expect(
      await prisma.emailLog.count({
        where: { to: comingEmail.toLowerCase(), category: 'meeting-guest-reminder' },
      })
    ).toBe(1);

    // Someone who already said no is left alone: they answered.
    expect(await prisma.emailLog.count({ where: { to: declinedEmail.toLowerCase() } })).toBe(0);
  } finally {
    await prisma.meeting.deleteMany({ where: { id: meeting.id } });
    await prisma.emailLog.deleteMany({
      where: { to: { in: [comingEmail.toLowerCase(), declinedEmail.toLowerCase()] } },
    });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(adminEmail);
  }
});
