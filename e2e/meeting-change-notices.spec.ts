import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, signInAsFreshUser } from './helpers/auth';
import { formatInTimeZone } from '@/lib/timezone';
import { emailGroupPrefKey } from '@/lib/emailGroups';

/**
 * Told when it moves, and able to counter-propose when you decline (#1982).
 *
 *   1. The invitee declines from the token page — no session — and suggests
 *      another time. That files a counter-proposal pointing at the meeting,
 *      the organiser sees it among their requests, and accepting it MOVES the
 *      meeting (the reschedule PATCH) instead of booking a second one. The
 *      move is then told to the mentee and the guest.
 *   2. Cancelling with a reason tells everyone; a mentee who silenced meeting
 *      e-mails still gets the in-app notice, and the guest still gets mail.
 */

const password = 'ChangeNotice123!';
const DAY = 24 * 60 * 60 * 1000;

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const guestEmail = uniqueEmail(`${prefix}-guest`);
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Notice Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Notice Mentee');
  // Different clocks on purpose: every notice must be read on its recipient's.
  await prisma.user.update({ where: { id: mentor.id }, data: { timezone: 'Europe/Istanbul' } });
  await prisma.user.update({ where: { id: mentee.id }, data: { timezone: 'America/New_York' } });
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  const meeting = await prisma.meeting.create({
    data: {
      relationId: relation.id,
      title: `Career check-in ${prefix}`,
      scheduledAt: new Date(Date.now() + 2 * DAY),
      timeZone: 'Europe/Istanbul',
      meetLink: 'https://meet.example.com/notice-room',
      rsvpToken: `e2e-notice-${Math.random().toString(36).slice(2)}`,
      createdById: mentor.id,
    },
  });
  await prisma.meetingGuest.create({
    data: { meetingId: meeting.id, email: guestEmail, name: 'Outside Guest', rsvpToken: `e2e-guest-${Math.random().toString(36).slice(2)}`, invitedById: mentor.id },
  });
  const cleanup = async () => {
    await prisma.meetingRequest.deleteMany({ where: { relationId: relation.id } });
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await prisma.emailLog.deleteMany({ where: { to: { in: [mentorEmail, menteeEmail, guestEmail] } } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
  };
  return { mentorEmail, menteeEmail, guestEmail, mentor, mentee, relation, meeting, cleanup };
}

test('decline with a counter-proposal → the organiser accepts → the meeting moves and everyone is told', async ({ page, browser }) => {
  const s = await seed('counter');
  try {
    // 1. The token page, with no account signed in.
    const anon = await browser.newContext();
    const invitee = await anon.newPage();
    await invitee.goto(`/rsvp/${s.meeting.rsvpToken}?r=no`);
    await expect(invitee.getByTestId('rsvp-suggest-form')).toBeVisible({ timeout: 15_000 });
    const wanted = new Date(Date.now() + 4 * DAY);
    const wall = `${wanted.toISOString().slice(0, 10)}T10:30`;
    await invitee.getByTestId('rsvp-suggest-at').fill(wall);
    await invitee.getByTestId('rsvp-suggest-submit').click();
    await expect(invitee.getByTestId('rsvp-suggested')).toBeVisible();
    await anon.close();

    const counter = await prisma.meetingRequest.findFirstOrThrow({ where: { counterOfMeetingId: s.meeting.id } });
    expect(counter).toMatchObject({ status: 'PENDING', requestedById: s.mentee.id, relationId: s.relation.id });
    expect((await prisma.meeting.findUniqueOrThrow({ where: { id: s.meeting.id } })).rsvp).toBe('DECLINED');
    await expect
      .poll(() => prisma.notification.count({ where: { userId: s.mentor.id, type: 'rsvp.counterProposed' } }))
      .toBe(1);

    // A guest token is a decline only — there is no relation to file it in.
    const guest = await prisma.meetingGuest.findFirstOrThrow({ where: { meetingId: s.meeting.id } });
    const guestRead = await (await page.request.get(`/api/rsvp?token=${guest.rsvpToken}`)).json();
    expect(guestRead.canCounter).toBe(false);

    // 2. The organiser sees it where they see every request, and accepts it.
    await signInAndSettle(page, s.mentorEmail, password, '/mentor');
    await page.goto(`/mentor/mentees/${s.relation.id}`);
    const row = page.getByTestId(`mreq-${counter.id}`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`mreq-counter-${counter.id}`)).toBeVisible();
    await row.getByRole('button', { name: 'Accept' }).click();

    // 3. The SAME meeting moved — no second one was booked.
    await expect
      .poll(async () => (await prisma.meeting.findUniqueOrThrow({ where: { id: s.meeting.id } })).scheduledAt?.getTime())
      .toBe(counter.proposedAt.getTime());
    expect(await prisma.meeting.count({ where: { relationId: s.relation.id } })).toBe(1);
    await expect.poll(async () => (await prisma.meetingRequest.findUniqueOrThrow({ where: { id: counter.id } })).status).toBe('ACCEPTED');

    // 4. Told: the mentee in-app and by mail, the guest by mail — not the mentor
    //    who made the change.
    await expect
      .poll(() => prisma.notification.count({ where: { userId: s.mentee.id, type: 'meeting.rescheduled' } }))
      .toBe(1);
    expect(await prisma.notification.count({ where: { userId: s.mentor.id, type: 'meeting.rescheduled' } })).toBe(0);
    const moved = await prisma.notification.findFirstOrThrow({ where: { userId: s.mentee.id, type: 'meeting.rescheduled' } });
    // On the mentee's clock (New York), in their language.
    expect((moved.params as { to: string }).to).toBe(formatInTimeZone(counter.proposedAt, 'America/New_York', undefined, 'en-GB'));
    await expect.poll(() => prisma.emailLog.count({ where: { to: s.menteeEmail, subject: { startsWith: 'Moved:' } } })).toBe(1);
    await expect.poll(() => prisma.emailLog.count({ where: { to: s.guestEmail, subject: { startsWith: 'Moved:' } } })).toBe(1);
  } finally {
    await s.cleanup();
  }
});

test('cancelling tells everyone with the reason — an e-mail opt-out still gets the in-app notice', async ({ page }) => {
  const s = await seed('cancel');
  // The mentee silenced meeting e-mails; the bell must still ring.
  await prisma.user.update({ where: { id: s.mentee.id }, data: { notificationPrefs: { [emailGroupPrefKey('meeting_invites')]: false } } });
  try {
    await signInAndSettle(page, s.mentorEmail, password, '/mentor');
    await page.goto('/mentor/meetings');
    await page.getByTestId(`meeting-cancel-${s.meeting.id}`).click();
    await page.getByTestId('meeting-cancel-reason').fill('The office is closed that day');
    await page.getByTestId('confirm-dialog').getByRole('button', { name: 'Cancel meeting' }).click();

    await expect.poll(async () => (await prisma.meeting.findUniqueOrThrow({ where: { id: s.meeting.id } })).status).toBe('CANCELLED');
    await expect
      .poll(() => prisma.notification.count({ where: { userId: s.mentee.id, type: 'meeting.cancelledReason' } }))
      .toBe(1);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: s.mentee.id, type: 'meeting.cancelledReason' } });
    expect((n.params as { reason: string }).reason).toBe('The office is closed that day');
    // The opted-out mentee's mail is suppressed by the central gate, visibly.
    await expect
      .poll(async () => (await prisma.emailLog.findFirst({ where: { to: s.menteeEmail, subject: { startsWith: 'Cancelled:' } } }))?.status)
      .toBe('SKIPPED');
    // The guest has no preferences to read and is always told.
    await expect.poll(() => prisma.emailLog.count({ where: { to: s.guestEmail, subject: { startsWith: 'Cancelled:' } } })).toBe(1);
    // Controls are gone from a called-off meeting.
    await page.reload();
    await expect(page.getByTestId(`meeting-cancel-${s.meeting.id}`)).toHaveCount(0);
  } finally {
    await s.cleanup();
  }
});

test('the organiser moves a meeting from the list; a mentee has no such route', async ({ page }) => {
  const s = await seed('move');
  try {
    await signInAndSettle(page, s.mentorEmail, password, '/mentor');
    await page.goto('/mentor/meetings');
    await page.getByTestId(`meeting-reschedule-${s.meeting.id}`).click();
    const target = new Date(Date.now() + 5 * DAY);
    await page.getByTestId(`meeting-move-at-${s.meeting.id}`).fill(`${target.toISOString().slice(0, 10)}T09:00`);
    await page.getByTestId(`meeting-move-save-${s.meeting.id}`).click();
    await expect
      .poll(async () => (await prisma.meeting.findUniqueOrThrow({ where: { id: s.meeting.id } })).previousScheduledAt)
      .not.toBeNull();
    await expect
      .poll(() => prisma.notification.count({ where: { userId: s.mentee.id, type: 'meeting.rescheduled' } }))
      .toBe(1);

    await page.context().clearCookies();
    await signInAsFreshUser(page, s.menteeEmail, password, '/portal');
    const res = await page.request.patch(`/api/meetings/${s.meeting.id}`, { data: { status: 'CANCELLED' } });
    expect(res.status()).toBe(404);
  } finally {
    await s.cleanup();
  }
});
