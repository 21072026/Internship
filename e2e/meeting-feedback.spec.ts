import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail, markSuperAdmin } from './helpers/db';
import { signInAndSettle } from './helpers/auth';
import { makeMeetingFeedbackToken } from '../src/lib/meetingFeedbackToken';

// Post-meeting feedback (#1896). Its own org: one mentor with six mentees,
// each pair with one past meeting.
//   • the one-click e-mail path records a rating with no login, and "we
//     didn't meet" is stored as its own answer, never as a low score;
//   • the sweep asks each mentee once — a second sweep asks nobody — and an
//     external guest is never asked;
//   • a mentor reads only the aggregate, only above the response floor, and
//     no response body ever carries a mentee's individual rating or note.

const PW = 'MeetingFeedback123!';
const MIN = 60 * 1000;
const NOTE = `the mentor kept checking their phone ${Date.now()}`;

test.describe('meeting feedback', () => {
  const stamp = `${Date.now()}`;
  const mentor = uniqueEmail('mf-mentor');
  const admin = uniqueEmail('mf-admin');
  const mentees = [0, 1, 2, 3, 4, 5].map((i) => uniqueEmail(`mf-mentee-${i}`));
  const guest = `mf-guest-${stamp}@example.com`;
  let orgId = '';
  let mentorId = '';
  const menteeIds: string[] = [];
  const meetingIds: string[] = [];

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `MF Org ${stamp}`, slug: `mf-${stamp}` } })).id;
    await seedUser(admin, PW, 'ADMIN', `MF Admin ${stamp}`, orgId);
    // It drives a platform-wide /api/cron job: the operator's trigger (#1575).
    await markSuperAdmin(admin);
    mentorId = (await seedUser(mentor, PW, 'MENTOR', `MF Mentor ${stamp}`, orgId)).id;
    for (const [i, email] of mentees.entries()) {
      const id = (await seedUser(email, PW, 'MENTEE', `MF Mentee ${i} ${stamp}`, orgId)).id;
      menteeIds.push(id);
      const rel = await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId: id, pipelineStatus: 'INTERVIEW_PENDING_250' } });
      // Three hours ago and never ended: exactly what the sweep picks up.
      const meeting = await prisma.meeting.create({
        data: { relationId: rel.id, title: `Check-in ${i}`, scheduledAt: new Date(Date.now() - 180 * MIN), rsvpToken: `mf-${stamp}-${i}`, createdById: mentorId },
      });
      meetingIds.push(meeting.id);
    }
    await prisma.meetingGuest.create({ data: { meetingId: meetingIds[0], email: guest, rsvpToken: `mf-guest-${stamp}`, invitedById: mentorId } });
  });

  test.afterAll(async () => {
    await prisma.emailLog.deleteMany({ where: { to: { in: [...mentees, guest] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [admin, mentor, ...mentees]) await cleanupByEmail(email);
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('one click from the e-mail records a rating with no login; "didn\'t meet" is its own answer', async ({ page }) => {
    const four = makeMeetingFeedbackToken({ meetingId: meetingIds[0], userId: menteeIds[0], rating: 4 });
    // GET reads and never writes — a mail scanner prefetching it changes nothing.
    expect((await page.request.get(`/api/meeting-feedback/${four}`)).status()).toBe(200);
    expect(await prisma.meetingFeedback.count({ where: { meetingId: meetingIds[0] } })).toBe(0);

    await page.goto(`/meeting-feedback/${four}`);
    await expect(page.getByTestId('meeting-feedback-saved')).toContainText('4/5');
    await page.getByTestId('meeting-feedback-note').fill(NOTE);
    await page.getByTestId('meeting-feedback-note-save').click();
    await expect.poll(async () => (await prisma.meetingFeedback.findUnique({ where: { meetingId_raterId: { meetingId: meetingIds[0], raterId: menteeIds[0] } } }))?.note).toBe(NOTE);
    expect(await prisma.meetingFeedback.findUniqueOrThrow({ where: { meetingId_raterId: { meetingId: meetingIds[0], raterId: menteeIds[0] } } })).toMatchObject({ happened: true, helpfulness: 4, orgId });

    const didNotMeet = makeMeetingFeedbackToken({ meetingId: meetingIds[1], userId: menteeIds[1], rating: 0 });
    await page.goto(`/meeting-feedback/${didNotMeet}`);
    await expect(page.getByTestId('meeting-feedback-saved')).toBeVisible();
    expect(await prisma.meetingFeedback.findUniqueOrThrow({ where: { meetingId_raterId: { meetingId: meetingIds[1], raterId: menteeIds[1] } } })).toMatchObject({ happened: false, helpfulness: null });

    // A tampered token is refused; a token for someone else's meeting records nothing.
    await page.goto(`/meeting-feedback/${four.slice(0, -2)}xx`);
    await expect(page.getByTestId('meeting-feedback-invalid')).toBeVisible();
    const foreign = makeMeetingFeedbackToken({ meetingId: meetingIds[2], userId: menteeIds[3], rating: 5 });
    expect((await page.request.post(`/api/meeting-feedback/${foreign}`, { data: {} })).status()).toBe(400);
  });

  test('the sweep asks each mentee once; a second sweep and the guest are never asked', async ({ page }) => {
    await signInAndSettle(page, admin, PW, '/admin');
    await page.request.get('/api/cron?job=meeting-logs');
    const asked = await prisma.meeting.findMany({ where: { id: { in: meetingIds } }, select: { id: true, feedbackAskedAt: true } });
    // Mentees 0 and 1 already answered from the e-mail test, so only 2..5 are asked.
    for (const m of asked) {
      const i = meetingIds.indexOf(m.id);
      if (i >= 2) expect(m.feedbackAskedAt, `meeting ${i}`).not.toBeNull();
    }
    const mails = () => prisma.emailLog.count({ where: { to: { in: mentees }, category: 'meeting-feedback' } });
    const first = await mails();
    expect(first).toBe(4);
    await page.request.get('/api/cron?job=meeting-logs');
    expect(await mails()).toBe(first);
    expect(await prisma.emailLog.count({ where: { to: guest, category: 'meeting-feedback' } })).toBe(0);
  });

  test('a mentor sees an aggregate above the floor and never an individual answer', async ({ page }) => {
    await signInAndSettle(page, mentor, PW, '/mentor');
    const read = async () => {
      const res = await page.request.get('/api/mentor/meeting-feedback');
      expect(res.status()).toBe(200);
      return { body: await res.json(), raw: await res.text() };
    };

    // Two answers so far: below the floor of five, so no number at all.
    const below = await read();
    expect(below.body.quality).toBeNull();

    // The mentor's own rating route returns their own answer — not the mentee's.
    const own = await (await page.request.get(`/api/meetings/${meetingIds[0]}/feedback`)).json();
    expect(own.feedback).toBeNull();

    // Four more mentees rate in the app: six answers, one of them "didn't meet".
    for (const i of [2, 3, 4, 5]) {
      await prisma.meetingFeedback.create({
        data: { orgId, meetingId: meetingIds[i], raterId: menteeIds[i], relationId: (await prisma.meeting.findUniqueOrThrow({ where: { id: meetingIds[i] } })).relationId, happened: true, helpfulness: i === 5 ? 2 : 5, note: NOTE },
      });
    }
    const above = await read();
    // Ratings 4, 5, 5, 5, 2 over the five that happened; one of six did not.
    expect(above.body.quality).toEqual({ n: 6, avgHelpfulness: 4.2, happenedRate: 0.83 });
    for (const forbidden of [NOTE, ...menteeIds, 'raterId', 'note']) expect(above.raw).not.toContain(forbidden);
  });

  test('ending a meeting offers the rating inline', async ({ page }) => {
    const rel = await prisma.mentorshipRelation.findFirstOrThrow({ where: { orgId, menteeId: menteeIds[5] } });
    const live = await prisma.meeting.create({
      data: { relationId: rel.id, title: `Live ${stamp}`, scheduledAt: new Date(Date.now() - 10 * MIN), meetLink: `https://example.com/room-${stamp}`, rsvpToken: `mf-live-${stamp}`, createdById: mentorId },
    });
    await signInAndSettle(page, mentor, PW, '/mentor');
    await expect(page.getByTestId('upcoming-meeting-banner')).toContainText(`Live ${stamp}`);
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('upcoming-meeting-end').click();
    // Who was there comes first since #2014 — everyone defaults to attended.
    await page.getByTestId('attendance-save').click();
    await expect(page.getByTestId('meeting-feedback-card')).toBeVisible();
    await page.getByTestId('meeting-feedback-happened-yes').click();
    await page.getByTestId('meeting-feedback-rate-5').click();
    await page.getByTestId('meeting-feedback-send').click();
    await expect(page.getByTestId('meeting-feedback-thanks')).toBeVisible();
    expect(await prisma.meetingFeedback.findUniqueOrThrow({ where: { meetingId_raterId: { meetingId: live.id, raterId: mentorId } } })).toMatchObject({ happened: true, helpfulness: 5 });
  });
});
