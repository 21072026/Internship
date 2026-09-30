import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// A meeting's length is one stored number (#1984). It used to be three guesses:
// the banner and the Google mirror assumed 60 minutes, every .ics we emitted 30.
// These tests read the length back from every surface a participant sees it on:
// the downloaded .ics, the subscription feed and the dashboard banner (the
// Google mirror is covered in e2e/google-calendar.spec.ts).

const PASSWORD = 'DurationPass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

/** DTEND − DTSTART of the VEVENT with this UID, in minutes. */
function eventMinutes(ics: string, uid: string): number {
  const block = ics.split('BEGIN:VEVENT').find((b) => b.includes(`UID:${uid}@`));
  if (!block) throw new Error(`no VEVENT for ${uid}`);
  const stamp = (key: string) => {
    const raw = new RegExp(`${key}:(\\d{8}T\\d{6}Z)`).exec(block)![1];
    return Date.parse(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`);
  };
  return (stamp('DTEND') - stamp('DTSTART')) / 60_000;
}

async function seedPair(prefix: string) {
  const mentorEmail = uniqueEmail(`${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`${prefix}-mentee`);
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Duration Mentor');
  const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Duration Mentee');
  const relation = await prisma.mentorshipRelation.create({ data: { mentorId: mentor.id, menteeId: mentee.id } });
  return {
    mentorEmail, menteeEmail, mentor, mentee, relation,
    cleanup: async () => {
      await prisma.meeting.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      await cleanupByEmail(menteeEmail);
      await cleanupByEmail(mentorEmail);
    },
  };
}

test('a 45-minute meeting is 45 minutes in the .ics and the feed; a legacy row reads 60, never 30', { tag: '@smoke' }, async ({ page, request }) => {
  const s = await seedPair('dur-ics');
  try {
    await signInAndSettle(page, s.mentorEmail, PASSWORD, '/mentor');

    const scheduledAt = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    scheduledAt.setUTCSeconds(0, 0);
    const created = await page.request.post('/api/meetings', {
      data: { relationIds: [s.relation.id], title: 'Forty-five', scheduledAt: scheduledAt.toISOString(), durationMinutes: 45 },
    });
    expect(created.ok()).toBeTruthy();
    const meeting = await prisma.meeting.findFirstOrThrow({ where: { relationId: s.relation.id, title: 'Forty-five' } });
    expect(meeting.durationMinutes).toBe(45);

    // The downloaded .ics — fetched without a session, as a calendar app does.
    const ics = await (await request.get(`/api/calendar/${meeting.rsvpToken}`)).text();
    expect(eventMinutes(ics, meeting.id)).toBe(45);

    // A row written before the column existed has no length: the one default.
    const legacy = await prisma.meeting.create({
      data: {
        relationId: s.relation.id, title: 'Legacy row', scheduledAt, rsvpToken: `dur-legacy-${Date.now()}`,
        createdById: s.mentor.id,
      },
    });
    const legacyIcs = await (await request.get(`/api/calendar/${legacy.rsvpToken}`)).text();
    expect(eventMinutes(legacyIcs, legacy.id)).toBe(60);

    // The subscription feed carries the same lengths.
    const token = (await (await page.request.post('/api/account/ics-feed')).json()).token as string;
    const feed = await (await request.get(`/api/calendar/feed/${token}`)).text();
    expect(eventMinutes(feed, meeting.id)).toBe(45);
    expect(eventMinutes(feed, legacy.id)).toBe(60);

    // Rescheduling can change the length, and the file follows.
    expect((await page.request.patch(`/api/meetings/${meeting.id}`, { data: { durationMinutes: 90 } })).ok()).toBeTruthy();
    expect(eventMinutes(await (await request.get(`/api/calendar/${meeting.rsvpToken}`)).text(), meeting.id)).toBe(90);

    // Out-of-range lengths are refused, not clamped.
    for (const bad of [3, 481]) {
      const res = await page.request.post('/api/meetings', {
        data: { relationIds: [s.relation.id], title: 'Bad length', scheduledAt: scheduledAt.toISOString(), durationMinutes: bad },
      });
      expect(res.status(), `durationMinutes ${bad}`).toBe(400);
    }
  } finally {
    await s.cleanup();
  }
});

test('the scheduling form offers the presets and sends the one picked', async ({ page }) => {
  const s = await seedPair('dur-form');
  try {
    await signInAndSettle(page, s.mentorEmail, PASSWORD, '/mentor');
    await page.goto('/mentor/meetings');
    const select = page.getByTestId('meeting-duration-select').first();
    await expect(select).toBeVisible({ timeout: 20_000 });
    await expect(select).toHaveValue('60');
    await expect(select.locator('option')).toHaveText(['15 min', '30 min', '45 min', '60 min', '90 min']);
    await select.selectOption('30');

    // The invitee row: the checkbox sits in a <label> with the mentee's name.
    await page.locator('label', { hasText: 'Duration Mentee' }).locator('input[type="checkbox"]').check();
    await page.getByLabel('Title', { exact: true }).fill('Picked thirty');
    const posted = page.waitForRequest((r) => r.url().endsWith('/api/meetings') && r.method() === 'POST');
    await page.getByRole('button', { name: 'Send invite' }).click();
    const body = (await posted).postDataJSON();
    expect(body.durationMinutes).toBe(30);
  } finally {
    await s.cleanup();
  }
});

test('the banner holds a meeting to its own length', async ({ page }) => {
  const s = await seedPair('dur-banner');
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  try {
    // Started 50 minutes ago: a 45-minute meeting is over, a legacy (60) one is on.
    const short = await prisma.meeting.create({
      data: {
        relationId: s.relation.id, title: 'Short one', scheduledAt: ago(50), durationMinutes: 45,
        meetLink: 'https://meet.example.com/short', rsvpToken: `dur-b1-${Date.now()}`, createdById: s.mentor.id,
      },
    });
    await signInAndSettle(page, s.mentorEmail, PASSWORD, '/mentor');
    let body = await (await page.request.get('/api/meetings/upcoming')).json();
    expect(body.meeting).toBeNull();

    await prisma.meeting.update({ where: { id: short.id }, data: { durationMinutes: null } });
    body = await (await page.request.get('/api/meetings/upcoming')).json();
    expect(body.meeting?.title).toBe('Short one');
    expect(body.meeting.ongoing).toBe(true);
    expect(body.durationMinutes).toBe(60);
    expect(Date.parse(body.meeting.endsAt) - Date.parse(body.meeting.startsAt)).toBe(60 * 60_000);

    // A two-hour workshop that started 90 minutes ago is still running.
    await prisma.meeting.update({ where: { id: short.id }, data: { scheduledAt: ago(90), durationMinutes: 120 } });
    body = await (await page.request.get('/api/meetings/upcoming')).json();
    expect(body.meeting?.ongoing).toBe(true);
    expect(body.durationMinutes).toBe(120);
  } finally {
    await s.cleanup();
  }
});
