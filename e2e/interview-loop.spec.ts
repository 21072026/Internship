import { test, expect, type APIRequestContext } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { gotoSettled, signInAsFreshUser, signInViaApi } from './helpers/auth';
import { companyInterestScopeKey } from '@/lib/companyInterests';
import { freshIp } from './helpers/rateLimit';

// The interview loop closes (#1844): a company asks, the programme approves,
// an approver turns the approval into a real Meeting on a named clock, the
// company's interviewer is invited as a guest with no account, the company
// sees the confirmed time, and a cancellation takes the meeting off the
// calendars without deleting it. Everything decided here is decided by the
// server: who may schedule, which slots count, and that two concurrent
// schedules produce one meeting.

const PW = 'InterviewLoop123!';
const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const emails = {
  admin: uniqueEmail('loop-admin'),
  company: uniqueEmail('loop-company'),
  mentor: uniqueEmail('loop-mentor'),
  mentee: uniqueEmail('loop-mentee'),
};
const guestEmail = `interviewer-${stamp}@guest.example.com`;
const SLOT_A = '2027-03-10T09:00:00.000Z';
const SLOT_B = '2027-03-11T13:30:00.000Z';
let org: { id: string };
let company: { id: string };
let adminUser: { id: string };
let mentorUser: { id: string };
let menteeUser: { id: string };
let relation: { id: string };
let req: { id: string };
let req2: { id: string };
let admin: APIRequestContext;
let companyCtx: APIRequestContext;
let mentee: APIRequestContext;
let requestId = '';
let meetingId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }, info) => {
  const hash = await bcrypt.hash(PW, 10);
  org = await prisma.organization.create({ data: { name: `Loop Org ${stamp}`, slug: `loop-${stamp}` }, select: { id: true } });
  company = await prisma.company.create({ data: { name: `Loop Co ${stamp}`, orgId: org.id }, select: { id: true } });
  const user = (email: string, role: 'ADMIN' | 'COMPANY' | 'MENTOR' | 'MENTEE', companyId?: string, timezone?: string, preferredLanguage?: string) =>
    prisma.user.create({ data: { email, password: hash, role, fullName: email.split('@')[0], orgId: org.id, companyId, timezone, preferredLanguage, skills: [], ...(role === 'MENTOR' ? { mentorOnboardingSeenAt: new Date() } : {}) }, select: { id: true } });
  adminUser = await user(emails.admin, 'ADMIN');
  await user(emails.company, 'COMPANY', company.id, 'Europe/Berlin', 'de');
  mentorUser = await user(emails.mentor, 'MENTOR');
  menteeUser = await user(emails.mentee, 'MENTEE', undefined, 'Europe/Istanbul', 'tr');
  relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, companyId: company.id, mentorId: mentorUser.id, menteeId: menteeUser.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' }, select: { id: true } });
  req = await prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: `Loop Backend ${stamp}`, openings: 1, requiredSkills: [] }, select: { id: true } });
  req2 = await prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: `Loop Data ${stamp}`, openings: 1, requiredSkills: [] }, select: { id: true } });
  for (const r of [req, req2]) {
    await prisma.companyInterest.create({ data: { companyId: company.id, menteeId: menteeUser.id, requisitionId: r.id, status: 'SHORTLISTED', scopeKey: companyInterestScopeKey(company.id, menteeUser.id, r.id) } });
  }
  const baseURL = info.project.use.baseURL;
  [admin, companyCtx, mentee] = await Promise.all([1, 2, 3].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, emails.admin, PW)).ok).toBe(true);
  expect((await signInViaApi(companyCtx, emails.company, PW)).ok).toBe(true);
  expect((await signInViaApi(mentee, emails.mentee, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, companyCtx, mentee].map((c) => c?.dispose()));
  const userIds = [adminUser, mentorUser, menteeUser].filter(Boolean).map((u) => u.id);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } }).catch(() => {});
  await prisma.interviewRequest.deleteMany({ where: { menteeId: menteeUser?.id } }).catch(() => {});
  await prisma.meeting.deleteMany({ where: { relationId: relation?.id } }).catch(() => {});
  await prisma.application.deleteMany({ where: { menteeId: menteeUser?.id } }).catch(() => {});
  await prisma.companyInterest.deleteMany({ where: { menteeId: menteeUser?.id } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { id: relation?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { id: { in: [req?.id, req2?.id].filter(Boolean) } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {});
  await prisma.company.deleteMany({ where: { id: company?.id } }).catch(() => {});
  await prisma.organization.deleteMany({ where: { id: org?.id } }).catch(() => {});
});

test('approve → schedule → the company sees the confirmed time; only the programme schedules, only proposed slots count', { tag: '@smoke' }, async ({ page }) => {
  const asked = await companyCtx.post('/api/interview-requests', { data: { requisitionId: req.id, menteeId: menteeUser.id, proposedSlots: [SLOT_A, SLOT_B] } });
  expect([200, 201]).toContain(asked.status());
  const row = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: req.id, menteeId: menteeUser.id }, select: { id: true } });
  requestId = row.id;
  const url = `/api/interview-requests/${requestId}/schedule`;
  const body = { slot: SLOT_A, timeZone: 'Europe/Berlin', guestEmails: [guestEmail] };
  // Not yet approved: refused server-side, whatever the UI shows.
  const early = await admin.post(url, { data: body });
  expect(early.status()).toBe(409);
  expect((await early.json()).code).toBe('not_approved');

  expect((await admin.patch(`/api/interview-requests/${requestId}`, { data: { action: 'approve' } })).status()).toBe(200);
  // A COMPANY never schedules; a MENTEE neither.
  expect((await companyCtx.post(url, { data: body })).status()).toBe(403);
  expect((await mentee.post(url, { data: body })).status()).toBe(403);
  // A time the company did not propose needs an explicit override.
  const notProposed = await admin.post(url, { data: { ...body, slot: '2027-03-12T10:00:00.000Z' } });
  expect(notProposed.status()).toBe(400);
  expect((await notProposed.json()).code).toBe('slot_not_proposed');
  expect((await admin.post(url, { data: { ...body, timeZone: 'Mars/Olympus' } })).status()).toBe(400);

  const meetingsBefore = await prisma.meeting.count({ where: { relationId: relation.id } });
  const scheduled = await admin.post(url, { data: body });
  expect(scheduled.status()).toBe(200);
  const result = await scheduled.json();
  expect(result.status).toBe('SCHEDULED');
  expect(result.scheduledAt).toBe(SLOT_A);
  meetingId = result.meetingId;

  const after = await prisma.interviewRequest.findUniqueOrThrow({ where: { id: requestId }, include: { meeting: { include: { guests: true } } } });
  expect(after.status).toBe('SCHEDULED');
  expect(after.meetingId).toBe(meetingId);
  expect(after.scheduledAt?.toISOString()).toBe(SLOT_A);
  expect(await prisma.meeting.count({ where: { relationId: relation.id } })).toBe(meetingsBefore + 1);
  expect(after.meeting).toMatchObject({ relationId: relation.id, timeZone: 'Europe/Berlin', status: 'SCHEDULED', createdById: adminUser.id });
  expect(after.meeting?.scheduledAt?.toISOString()).toBe(SLOT_A);
  expect(after.meeting?.title).toContain(`Loop Backend ${stamp}`);
  // The company's interviewer is a guest with no account and their own token.
  expect(after.meeting?.guests).toHaveLength(1);
  const guest = after.meeting!.guests[0];
  expect(guest.email).toBe(guestEmail);
  expect(await prisma.user.count({ where: { email: guestEmail } })).toBe(0);
  const rsvp = await mentee.post('/api/rsvp', { data: { token: guest.rsvpToken, response: 'yes' }, headers: freshIp('interview-loop guest rsvp') });
  expect(rsvp.status()).toBe(200);
  expect((await prisma.meetingGuest.findUniqueOrThrow({ where: { id: guest.id } })).rsvp).toBe('ACCEPTED');

  // Everyone hears the confirmed time, on their own clock: the mentee in
  // Istanbul (12:00, GMT+3), the company in Berlin (10:00, GMT+1).
  const menteeNote = await prisma.notification.findFirstOrThrow({ where: { userId: menteeUser.id, type: 'interview_request.scheduled' }, select: { params: true } });
  expect(JSON.stringify(menteeNote.params)).toContain('12:00');
  expect(JSON.stringify(menteeNote.params)).toContain('GMT+3');
  const companyUser = await prisma.user.findFirstOrThrow({ where: { email: emails.company }, select: { id: true } });
  const companyNote = await prisma.notification.findFirstOrThrow({ where: { userId: companyUser.id, type: 'interview_request.scheduled' }, select: { params: true } });
  expect(JSON.stringify(companyNote.params)).toContain('10:00');
  expect(JSON.stringify(companyNote.params)).toContain('GMT+1');
  expect(await prisma.notification.count({ where: { userId: mentorUser.id, type: 'interview_request.scheduled' } })).toBe(1);

  // Scheduling twice is refused: the status is no longer APPROVED.
  expect((await admin.post(url, { data: body })).status()).toBe(409);

  // The company screen shows the outcome, not an instruction.
  await signInAsFreshUser(page, emails.company, PW, '/company');
  await gotoSettled(page, `/company/requisitions/${req.id}`);
  const shown = page.locator('[data-testid="interview-scheduled-at"]:visible');
  await expect(shown).toBeVisible();
  await expect(shown).toContainText('2027');
  await expect(shown).toContainText('GMT');
  await expect(page.getByText('Coordinate the interview with the program team.')).toHaveCount(0);
});

test('two concurrent schedules produce one meeting and one 409', async () => {
  const asked = await companyCtx.post('/api/interview-requests', { data: { requisitionId: req2.id, menteeId: menteeUser.id, proposedSlots: [SLOT_B] } });
  expect([200, 201]).toContain(asked.status());
  const row = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: req2.id, menteeId: menteeUser.id }, select: { id: true } });
  expect((await admin.patch(`/api/interview-requests/${row.id}`, { data: { action: 'approve' } })).status()).toBe(200);
  const before = await prisma.meeting.count({ where: { relationId: relation.id } });
  const url = `/api/interview-requests/${row.id}/schedule`;
  const body = { slot: SLOT_B, timeZone: 'Europe/Istanbul' };
  const [a, b] = await Promise.all([admin.post(url, { data: body }), admin.post(url, { data: body })]);
  expect([a.status(), b.status()].sort()).toEqual([200, 409]);
  // The loser's meeting rolled back with its transaction: exactly one row.
  expect(await prisma.meeting.count({ where: { relationId: relation.id } })).toBe(before + 1);
  const after = await prisma.interviewRequest.findUniqueOrThrow({ where: { id: row.id } });
  expect(after.status).toBe('SCHEDULED');
  expect(after.meetingId).not.toBeNull();
});

test('a cancellation writes CANCELLED and takes the meeting off the calendars without deleting it', async () => {
  const url = `/api/interview-requests/${requestId}/cancel`;
  // The mentee is not an actor here.
  expect((await mentee.post(url, { data: {} })).status()).toBe(403);
  // The company may cancel its own request.
  const cancelled = await companyCtx.post(url, { data: { reason: 'Role filled internally' } });
  expect(cancelled.status()).toBe(200);
  const after = await prisma.interviewRequest.findUniqueOrThrow({ where: { id: requestId }, include: { meeting: true } });
  expect(after.status).toBe('CANCELLED');
  expect(after.cancelReason).toBe('Role filled internally');
  expect(after.cancelledAt).not.toBeNull();
  expect(after.meeting).not.toBeNull();
  expect(after.meeting?.status).toBe('CANCELLED');
  expect(after.meeting?.cancelReason).toBe('Role filled internally');
  // Off the calendar: the meetings list no longer shows it as on.
  const list = await admin.get('/api/meetings');
  expect(list.status()).toBe(200);
  const mine = (await list.json()).meetings.find((m: { id: string }) => m.id === meetingId);
  expect(mine?.status).toBe('CANCELLED');
  // The mentee and the mentor are told; the company cancelled, so it is not.
  expect(await prisma.notification.count({ where: { userId: menteeUser.id, type: 'interview_request.cancelled' } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: mentorUser.id, type: 'interview_request.cancelled' } })).toBe(1);
  // Terminal: a second cancellation and a late schedule are both refused.
  expect((await companyCtx.post(url, { data: {} })).status()).toBe(409);
  expect((await admin.post(`/api/interview-requests/${requestId}/schedule`, { data: { slot: SLOT_A, timeZone: 'Europe/Berlin' } })).status()).toBe(409);
});
