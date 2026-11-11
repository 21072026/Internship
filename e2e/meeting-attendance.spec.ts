import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle } from './helpers/auth';

// Meeting attendance (#2014). Its own org with six pairs, so the programme
// figures clear the reporting floor of five.
//   • record → a no-show → the admin figure moves; one neutral note, once;
//   • the mentor's record wins; a double record is impossible on either shape;
//   • a cancellation inside the window is LATE_CANCEL without anyone typing it;
//   • deleting a meeting keeps its attendance.

const PW = 'Attendance123!';
const HOUR = 60 * 60 * 1000;

test.describe('meeting attendance', () => {
  const stamp = `${Date.now()}`;
  const admin = uniqueEmail('ma-admin');
  const mentor = uniqueEmail('ma-mentor');
  const mentees = [0, 1, 2, 3, 4, 5].map((i) => uniqueEmail(`ma-mentee-${i}`));
  let orgId = '';
  let mentorId = '';
  const menteeIds: string[] = [];
  const relationIds: string[] = [];
  const meetingIds: string[] = [];

  const seedMeeting = async (relationId: string, at: Date, title: string) =>
    (await prisma.meeting.create({ data: { relationId, title, scheduledAt: at, createdById: mentorId, rsvpToken: randomBytes(16).toString('hex') } })).id;

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `MA Org ${stamp}`, slug: `ma-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `MA Admin ${stamp}`, orgId);
    mentorId = (await seedUser(mentor, PW, 'MENTOR', `MA Mentor ${stamp}`, orgId)).id;
    for (const [i, email] of mentees.entries()) {
      const id = (await seedUser(email, PW, 'MENTEE', `MA Mentee ${i} ${stamp}`, orgId)).id;
      menteeIds.push(id);
      relationIds.push((await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId: id, expectedMeetingIntervalWeeks: 2 } })).id);
      // Every pair met two days ago.
      meetingIds.push(await seedMeeting(relationIds[i], new Date(Date.now() - 48 * HOUR), `Weekly ${i}`));
    }
  });

  test.afterAll(async () => {
    await prisma.meetingAttendance.deleteMany({ where: { orgId } });
    await prisma.meetingSeries.deleteMany({ where: { relationId: { in: relationIds } } });
    await prisma.meeting.deleteMany({ where: { relationId: { in: relationIds } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('record a no-show → one neutral note → the admin figure moves; the mentor\'s record wins', async ({ browser }) => {
    // Four people sign in: well past the default budget on a cold server.
    test.slow();
    const admin1 = await (await browser.newContext()).newPage();
    await signInAndSettle(admin1, admin, PW, '/admin');
    const before = (await (await admin1.request.get('/api/admin/analytics/attendance')).json()).attendance;
    expect(before).toMatchObject({ activePairs: 6, metRecently: { pct: 100, basis: 6 }, onCadence: { pct: 100, basis: 6 }, noShowRate: { pct: 0, basis: 6 } });

    const m = await (await browser.newContext()).newPage();
    await signInAndSettle(m, mentor, PW, '/mentor');
    const record = (state: string) =>
      m.request.post(`/api/meetings/${meetingIds[0]}/attendance`, { data: { entries: [{ userId: menteeIds[0], state }, { userId: mentorId, state: 'ATTENDED' }] } });
    expect((await (await record('NO_SHOW')).json()).result).toMatchObject({ saved: 2 });
    expect((await (await record('NO_SHOW')).json()).result).toMatchObject({ saved: 2 }); // a correction, not a second row
    expect(await prisma.meetingAttendance.count({ where: { meetingId: meetingIds[0] } })).toBe(2);
    // The bus (#1998): one event per person per write (two writes × two people).
    const recorded = await prisma.domainEvent.findMany({ where: { name: 'meeting.attendance_recorded', payload: { path: '$.meetingId', equals: meetingIds[0] } } });
    expect(recorded).toHaveLength(4);
    expect(recorded.filter((e) => (e.payload as { userId: string; state: string }).userId === menteeIds[0]).every((e) => (e.payload as { state: string }).state === 'NO_SHOW')).toBe(true);
    // Exactly one neutral note to the absent mentee — and none to anyone else.
    expect(await prisma.notification.count({ where: { userId: menteeIds[0], type: 'meeting.noShow' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: mentorId, type: 'meeting.noShow' } })).toBe(0);
    // Somebody who is not one of the pair cannot be recorded.
    expect((await m.request.post(`/api/meetings/${meetingIds[0]}/attendance`, { data: { entries: [{ userId: menteeIds[1], state: 'ATTENDED' }] } })).status()).toBe(400);
    // LATE_CANCEL is derived, never posted.
    expect((await m.request.post(`/api/meetings/${meetingIds[0]}/attendance`, { data: { entries: [{ userId: menteeIds[0], state: 'LATE_CANCEL' }] } })).status()).toBe(400);

    // The mentee says they were there — the mentor's record stands.
    const me = await (await browser.newContext()).newPage();
    await signInAndSettle(me, mentees[0], PW, '/portal');
    const mine = await me.request.post(`/api/meetings/${meetingIds[0]}/attendance`, { data: { entries: [{ userId: menteeIds[0], state: 'ATTENDED' }] } });
    expect((await mine.json()).result).toMatchObject({ saved: 0, kept: 1 });
    expect((await prisma.meetingAttendance.findFirstOrThrow({ where: { meetingId: meetingIds[0], userId: menteeIds[0] } })).state).toBe('NO_SHOW');
    // Another mentee cannot even see this meeting.
    const other = await (await browser.newContext()).newPage();
    await signInAndSettle(other, mentees[1], PW, '/portal');
    expect((await other.request.get(`/api/meetings/${meetingIds[0]}/attendance`)).status()).toBe(404);

    // The figure moved: 5 of 6 pairs met, 1 of 6 meetings was a no-show.
    const after = (await (await admin1.request.get('/api/admin/analytics/attendance')).json()).attendance;
    expect(after).toMatchObject({ metRecently: { pct: 83, basis: 6 }, onCadence: { pct: 83, basis: 6 }, noShowRate: { pct: 17, basis: 6 } });
    await admin1.goto('/admin/analytics');
    await expect(admin1.getByTestId('attendance-met-value')).toHaveText('83%');
    await expect(admin1.getByTestId('attendance-noShow-value')).toHaveText('17%');
  });

  test('a late cancellation is recorded for whoever cancelled; an early one is not', async ({ page }) => {
    const soon = await seedMeeting(relationIds[1], new Date(Date.now() + 2 * HOUR), 'Soon');
    const later = await seedMeeting(relationIds[2], new Date(Date.now() + 5 * 24 * HOUR), 'Later');
    await signInAndSettle(page, mentor, PW, '/mentor');
    for (const id of [soon, later]) {
      expect((await page.request.patch(`/api/meetings/${id}`, { data: { status: 'CANCELLED', cancelReason: 'Clash' } })).status()).toBe(200);
    }
    expect(await prisma.meetingAttendance.findMany({ where: { meetingId: soon }, select: { userId: true, state: true, recordedById: true } })).toEqual([
      { userId: mentorId, state: 'LATE_CANCEL', recordedById: mentorId },
    ]);
    expect(await prisma.meetingAttendance.count({ where: { meetingId: later } })).toBe(0);
    // The derived LATE_CANCEL is announced like a recorded one (#1998).
    const late = await prisma.domainEvent.findMany({ where: { name: 'meeting.attendance_recorded', payload: { path: '$.meetingId', equals: soon } } });
    expect(late.map((e) => e.payload)).toEqual([expect.objectContaining({ userId: mentorId, state: 'LATE_CANCEL' })]);
  });

  test('a recurring occurrence records on its own key, and deleting a meeting keeps its attendance', async ({ page }) => {
    // A standing 1:1 whose occurrence started ten minutes ago (UTC, like the end spec).
    const target = new Date(Date.now() - 10 * 60 * 1000);
    target.setUTCSeconds(0, 0);
    const hhmm = `${String(target.getUTCHours()).padStart(2, '0')}:${String(target.getUTCMinutes()).padStart(2, '0')}`;
    const series = await prisma.meetingSeries.create({
      data: { relationId: relationIds[3], title: 'Standing 1:1', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], timeOfDay: hhmm, timeZone: 'UTC', createdById: mentorId },
    });
    await signInAndSettle(page, mentor, PW, '/mentor');
    const occurrence = encodeURIComponent(`${series.id}:${target.toISOString()}`);
    const res = await page.request.post(`/api/meetings/${occurrence}/attendance`, { data: { entries: [{ userId: menteeIds[3], state: 'EXCUSED' }] } });
    expect(res.status()).toBe(200);
    expect(await prisma.meetingAttendance.count({ where: { seriesId: series.id, occurrenceAt: target } })).toBe(1);
    // An instant that is not an occurrence of the rule is not a meeting.
    const bogus = encodeURIComponent(`${series.id}:${new Date(target.getTime() + 7 * 60 * 1000).toISOString()}`);
    expect((await page.request.post(`/api/meetings/${bogus}/attendance`, { data: { entries: [{ userId: menteeIds[3], state: 'ATTENDED' }] } })).status()).toBe(404);

    // Deleting the meeting does not delete that someone did not show up.
    const doomed = await seedMeeting(relationIds[4], new Date(Date.now() - 24 * HOUR), 'To be deleted');
    expect((await page.request.post(`/api/meetings/${doomed}/attendance`, { data: { entries: [{ userId: menteeIds[4], state: 'NO_SHOW' }] } })).status()).toBe(200);
    expect((await page.request.delete(`/api/meetings/${doomed}`)).ok()).toBeTruthy();
    expect(await prisma.meeting.count({ where: { id: doomed } })).toBe(0);
    const kept = await prisma.meetingAttendance.findFirstOrThrow({ where: { relationId: relationIds[4], userId: menteeIds[4], meetingAt: { lt: new Date() } } });
    expect(kept).toMatchObject({ meetingId: null, state: 'NO_SHOW' });
  });
});
