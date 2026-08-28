import { test, expect } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

/**
 * A meeting that took place logs itself as an interaction (#1489).
 *
 * The app scheduled the meeting, so it already knows it happened — the mentor
 * should not have to re-type it into the interaction log. Two paths, both
 * covered here: the participant clicking "meeting is over", and the sweep that
 * picks up the meetings nobody ended.
 */

const password = 'AutoLogPass123!';
const minutesFromNow = (m: number) => new Date(Date.now() + m * 60 * 1000);

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, password, 'MENTOR', 'Auto Log Mentor');
  const mentee = await seedUser(menteeEmail, password, 'MENTEE', 'Auto Log Mentee');
  const relation = await prisma.mentorshipRelation.create({
    data: { mentorId: mentor.id, menteeId: mentee.id },
  });
  return { mentorEmail, menteeEmail, mentor, mentee, relation };
}

function seedMeeting(relationId: string, scheduledAt: Date, title: string) {
  return prisma.meeting.create({
    data: {
      relationId,
      title,
      scheduledAt,
      meetLink: `https://meet.example.com/autolog-${crypto.randomBytes(4).toString('hex')}`,
      rsvpToken: `e2e-${crypto.randomBytes(8).toString('hex')}`,
      createdById: 'e2e',
    },
  });
}

test('ending a meeting writes its interaction log, and the mentor sees it marked auto', async ({ page }) => {
  const { mentorEmail, menteeEmail, relation } = await seedPair('autolog-end');
  const meeting = await seedMeeting(relation.id, minutesFromNow(-10), 'Weekly sync on the internship');

  try {
    await signInAndSettle(page, mentorEmail, password, '/mentor');
    const end = await page.request.post(`/api/meetings/${meeting.id}/end`);
    expect(end.ok()).toBe(true);

    const log = await prisma.interactionLog.findUnique({ where: { meetingId: meeting.id } });
    expect(log?.type).toBe('Meeting');
    expect(log?.autoLogged).toBe(true);
    expect(log?.subject).toBe('Weekly sync on the internship');
    // Dated when the meeting was held — not when the log happened to be written.
    expect(log?.date.getTime()).toBe(meeting.scheduledAt!.getTime());

    await page.goto(`/mentor/mentees/${relation.id}`);
    await expect(page.getByText('Weekly sync on the internship')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('interaction-auto-logged').first()).toBeVisible();
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
  }
});

test('a meeting nobody ended is logged by the sweep once the grace period has passed', async ({ page }) => {
  const adminEmail = uniqueEmail('autolog-admin');
  await seedUser(adminEmail, password, 'ADMIN', 'Auto Log Admin');
  const { mentorEmail, menteeEmail, relation } = await seedPair('autolog-sweep');
  // Past the two-hour grace window, so it counts as held…
  const held = await seedMeeting(relation.id, minutesFromNow(-180), 'Career planning talk');
  // …while one inside the window is still someone's ongoing meeting.
  const recent = await seedMeeting(relation.id, minutesFromNow(-30), 'Just started');
  // A declined invitation is the one signal that it did not happen for this pair.
  const declined = await seedMeeting(relation.id, minutesFromNow(-300), 'Declined slot');
  await prisma.meeting.update({ where: { id: declined.id }, data: { rsvp: 'DECLINED' } });
  // Older than the lookback window: history is not rewritten months later.
  const ancient = await seedMeeting(relation.id, minutesFromNow(-60 * 24 * 60), 'Last quarter');

  try {
    await signInAndSettle(page, adminEmail, password, '/admin');
    const res = await page.request.get('/api/cron?job=meeting-logs');
    expect(res.ok()).toBe(true);

    expect(await prisma.interactionLog.findUnique({ where: { meetingId: held.id } })).not.toBeNull();
    expect(await prisma.interactionLog.findUnique({ where: { meetingId: recent.id } })).toBeNull();
    expect(await prisma.interactionLog.findUnique({ where: { meetingId: declined.id } })).toBeNull();
    expect(await prisma.interactionLog.findUnique({ where: { meetingId: ancient.id } })).toBeNull();

    // Running it again writes nothing new — the unique meetingId is the guard.
    await page.request.get('/api/cron?job=meeting-logs');
    expect(await prisma.interactionLog.count({ where: { relationId: relation.id } })).toBe(1);

    // And the calendar shows the meeting once, not as a scheduled event plus a
    // logged one describing the very same meeting.
    const log = await prisma.interactionLog.findUnique({ where: { meetingId: held.id } });
    const feed = await (await page.request.get('/api/calendar-events')).json();
    const ids = feed.events.map((e: { id: string }) => e.id);
    expect(ids).toContain(`meeting-${held.id}`);
    expect(ids).not.toContain(`logged-${log!.id}`);
  } finally {
    await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
    await cleanupByEmail(mentorEmail);
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(adminEmail);
  }
});
