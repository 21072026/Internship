import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { randomBytes } from 'crypto';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The relationship's remaining lifecycle events (#1998), driven through the
// real routes and read back from the DomainEvent record: a weekly report
// handed in and handed in again, a shared goal completed (and a PRIVATE one
// that raises nothing), attendance recorded per person. Ids, states and dates
// only — never the report text, the goal title or an attendance note.

const PW = 'LifecycleEv123!';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const stamp = `${Date.now()}-${randomBytes(3).toString('hex')}`;
const emails = { mentor: uniqueEmail('lcev-mentor'), mentee: uniqueEmail('lcev-mentee') };
let orgId = '';
let relationId = '';
let mentorId = '';
let menteeId = '';
const contexts: APIRequestContext[] = [];

async function signedIn(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  contexts.push(ctx);
  expect((await signInViaApi(ctx, email, PW)).ok).toBe(true);
  return ctx;
}

const events = (name: string, subjectId: string) =>
  prisma.domainEvent.findMany({ where: { name, subjectId }, orderBy: { createdAt: 'asc' } });

test.beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `LcEv ${stamp}`, slug: `lcev-${stamp}` } })).id;
  mentorId = (await seedUser(emails.mentor, PW, 'MENTOR', 'LcEv Mentor', orgId)).id;
  menteeId = (await seedUser(emails.mentee, PW, 'MENTEE', 'LcEv Mentee', orgId)).id;
  relationId = (await prisma.mentorshipRelation.create({ data: { orgId, mentorId, menteeId } })).id;
});

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.dispose();
  await prisma.domainEvent.deleteMany({ where: { orgId } });
  await prisma.meetingAttendance.deleteMany({ where: { orgId } });
  await prisma.meeting.deleteMany({ where: { relationId } });
  await prisma.weeklyReport.deleteMany({ where: { relationId } });
  await prisma.goal.deleteMany({ where: { relationId } });
  await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
  await prisma.user.deleteMany({ where: { orgId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
});

test('weekly reports, goals and attendance raise their events, with ids and states only', async () => {
  const [mentor, mentee] = await Promise.all([signedIn(emails.mentor), signedIn(emails.mentee)]);

  // A report handed in, sent back, handed in again: two events; the draft-free
  // review in between raises none.
  const created = await mentee.post('/api/weekly-reports', { data: { relationId, summary: 'Secret progress text', status: 'SUBMITTED' } });
  expect(created.status()).toBe(201);
  const reportId = (await created.json()).report.id as string;
  expect((await mentor.patch(`/api/weekly-reports/${reportId}`, { data: { status: 'CHANGES_REQUESTED', mentorComment: 'More detail' } })).status()).toBe(200);
  expect((await mentee.patch(`/api/weekly-reports/${reportId}`, { data: { summary: 'Secret progress text, more', status: 'SUBMITTED' } })).status()).toBe(200);
  const handIns = await events('weekly_report.submitted', reportId);
  expect(handIns.map((e) => (e.payload as { resubmission: boolean }).resubmission)).toEqual([false, true]);
  expect(handIns[0].payload).toMatchObject({ reportId, relationId });
  expect(JSON.stringify(handIns.map((e) => e.payload))).not.toContain('Secret');

  // A shared goal done once: one event; ticking it again does nothing; a
  // PRIVATE goal is its author's alone and raises nothing.
  const shared = await prisma.goal.create({ data: { relationId, title: 'Shared goal', createdById: mentorId, createdByRole: 'MENTOR' } });
  const privateGoal = await prisma.goal.create({ data: { relationId, title: 'Private goal', createdById: mentorId, createdByRole: 'MENTOR', visibility: 'PRIVATE' } });
  for (let i = 0; i < 2; i++) expect((await mentor.patch(`/api/goals/${shared.id}`, { data: { status: 'DONE' } })).status()).toBe(200);
  expect((await mentor.patch(`/api/goals/${privateGoal.id}`, { data: { status: 'DONE' } })).status()).toBe(200);
  expect((await events('goal.completed', shared.id)).map((e) => e.payload)).toEqual([{ goalId: shared.id, relationId }]);
  expect(await events('goal.completed', privateGoal.id)).toHaveLength(0);

  // Attendance for the pair's two people: one event per person.
  const meeting = await prisma.meeting.create({
    data: { relationId, title: 'Check-in', scheduledAt: new Date(Date.now() - 48 * 3600 * 1000), createdById: mentorId, rsvpToken: randomBytes(16).toString('hex') },
  });
  const recorded = await mentor.post(`/api/meetings/${meeting.id}/attendance`, {
    data: { entries: [{ userId: menteeId, state: 'NO_SHOW', note: 'private note' }, { userId: mentorId, state: 'ATTENDED' }] },
  });
  expect(recorded.status()).toBe(200);
  const att = await prisma.domainEvent.findMany({ where: { name: 'meeting.attendance_recorded', payload: { path: '$.meetingId', equals: meeting.id } } });
  expect(att.map((e) => [(e.payload as { userId: string }).userId, (e.payload as { state: string }).state]).sort()).toEqual(
    [[menteeId, 'NO_SHOW'], [mentorId, 'ATTENDED']].sort(),
  );
  expect(JSON.stringify(att.map((e) => e.payload))).not.toContain('private note');
});
