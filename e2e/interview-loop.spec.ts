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
let mentorCtx: APIRequestContext;
let req3: { id: string };
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
  req3 = await prisma.requisition.create({ data: { orgId: org.id, companyId: company.id, title: `Loop Platform ${stamp}`, openings: 1, requiredSkills: [] }, select: { id: true } });
  for (const r of [req, req2, req3]) {
    await prisma.companyInterest.create({ data: { companyId: company.id, menteeId: menteeUser.id, requisitionId: r.id, status: 'SHORTLISTED', scopeKey: companyInterestScopeKey(company.id, menteeUser.id, r.id) } });
  }
  // The first role's shortlist as the deploy backfill leaves it — an application — so the company board (#1838) has a card to show the outcome on.
  await prisma.application.create({ data: { orgId: org.id, requisitionId: req.id, menteeId: menteeUser.id, companyId: company.id, stage: 'SHORTLISTED', status: 'ACTIVE', source: 'SHORTLIST' } });
  const baseURL = info.project.use.baseURL;
  [admin, companyCtx, mentee, mentorCtx] = await Promise.all([1, 2, 3, 4].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, emails.admin, PW)).ok).toBe(true);
  expect((await signInViaApi(mentorCtx, emails.mentor, PW)).ok).toBe(true);
  expect((await signInViaApi(companyCtx, emails.company, PW)).ok).toBe(true);
  expect((await signInViaApi(mentee, emails.mentee, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, companyCtx, mentee, mentorCtx].map((c) => c?.dispose()));
  await prisma.interviewPanel.deleteMany({ where: { subjectId: menteeUser?.id } }).catch(() => {});
  await prisma.statusChange.deleteMany({ where: { relationId: relation?.id } }).catch(() => {});
  const userIds = [adminUser, mentorUser, menteeUser].filter(Boolean).map((u) => u.id);
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } }).catch(() => {});
  await prisma.interviewRequest.deleteMany({ where: { menteeId: menteeUser?.id } }).catch(() => {});
  await prisma.meeting.deleteMany({ where: { relationId: relation?.id } }).catch(() => {});
  await prisma.application.deleteMany({ where: { menteeId: menteeUser?.id } }).catch(() => {});
  await prisma.companyInterest.deleteMany({ where: { menteeId: menteeUser?.id } }).catch(() => {});
  await prisma.mentorshipRelation.deleteMany({ where: { id: relation?.id } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { id: { in: [req?.id, req2?.id, req3?.id].filter((id): id is string => Boolean(id)) } } }).catch(() => {});
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

test('the panel convened with the meeting scores it; a closed panel\'s outcome moves the application and tells the company the decision only', async () => {
  // The application the panel will decide on: shortlisted, moved to INTERVIEW by the approval (#1836).
  const application = await prisma.application.create({
    data: { orgId: org.id, requisitionId: req3.id, menteeId: menteeUser.id, companyId: company.id, stage: 'SHORTLISTED', status: 'ACTIVE', source: 'SHORTLIST' },
    select: { id: true },
  });
  const asked = await companyCtx.post('/api/interview-requests', { data: { requisitionId: req3.id, menteeId: menteeUser.id, proposedSlots: [SLOT_A] } });
  expect([200, 201]).toContain(asked.status());
  const row = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: req3.id, menteeId: menteeUser.id }, select: { id: true } });
  expect((await admin.patch(`/api/interview-requests/${row.id}`, { data: { action: 'approve' } })).status()).toBe(200);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: application.id } })).stage).toBe('INTERVIEW');

  // Scheduling with createPanel convenes the panel in the same transaction: its scheduledAt is the meeting's.
  const scheduled = await admin.post(`/api/interview-requests/${row.id}/schedule`, {
    data: { slot: SLOT_A, timeZone: 'Europe/Berlin', createPanel: true, interviewerIds: [mentorUser.id, adminUser.id] },
  });
  expect(scheduled.status()).toBe(200);
  const { meetingId: panelMeetingId, panelId } = await scheduled.json();
  expect(panelId).toBeTruthy();
  const panel = await prisma.interviewPanel.findUniqueOrThrow({ where: { id: panelId }, include: { members: true } });
  expect(panel.meetingId).toBe(panelMeetingId);
  expect(panel.scheduledAt?.toISOString()).toBe(SLOT_A);
  expect(panel.subjectId).toBe(menteeUser.id);
  expect(panel.members.map((m) => m.userId).sort()).toEqual([adminUser.id, mentorUser.id].sort());
  expect((await prisma.interviewRequest.findUniqueOrThrow({ where: { id: row.id } })).panelId).toBe(panelId);
  // Both interviewers were assigned the panel.
  expect(await prisma.notification.count({ where: { userId: mentorUser.id, type: { in: ['interview.assigned', 'interview.assignedBlind'] } } })).toBeGreaterThanOrEqual(1);

  const url = `/api/interview-panels/${panelId}/outcome`;
  const offer = { decision: 'OFFER', applicationId: application.id };
  // No outcome pre-empts the scorecards.
  const early = await admin.post(url, { data: offer });
  expect(early.status()).toBe(409);
  expect((await early.json()).code).toBe('panel_open');
  expect((await admin.post(`/api/interview-panels/${panelId}/close`)).status()).toBe(200);
  // Neither the candidate nor the company decides.
  expect((await mentee.post(url, { data: offer })).status()).toBe(403);
  expect((await companyCtx.post(url, { data: offer })).status()).toBe(403);
  // A rejection needs a reason code.
  const noReason = await admin.post(url, { data: { decision: 'REJECT', applicationId: application.id } });
  expect(noReason.status()).toBe(400);
  expect((await noReason.json()).code).toBe('disposition_required');
  // The panel view hands the decider the candidate's open applications.
  const view = await (await admin.get(`/api/interview-panels/${panelId}`)).json();
  expect(view.panel.canDecide).toBe(true);
  expect(view.applications.map((a: { id: string }) => a.id)).toContain(application.id);

  const companyUser = await prisma.user.findFirstOrThrow({ where: { email: emails.company }, select: { id: true } });
  const beforePipeline = (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus;
  const recorded = await admin.post(url, { data: offer });
  expect(recorded.status()).toBe(200);
  const body = await recorded.json();
  expect(body.application).toMatchObject({ id: application.id, fromStage: 'INTERVIEW', stage: 'OFFER' });
  expect(body.pipeline).toBeNull();
  const app = await prisma.application.findUniqueOrThrow({ where: { id: application.id }, include: { events: true } });
  expect(app.stage).toBe('OFFER');
  expect(app.events.map((e) => e.toStage)).toEqual(['INTERVIEW', 'OFFER']);
  const sealed = await prisma.interviewPanel.findUniqueOrThrow({ where: { id: panelId } });
  expect(sealed).toMatchObject({ outcome: 'OFFER', outcomeById: adminUser.id, outcomeApplicationId: application.id });
  expect(sealed.outcomeAt).not.toBeNull();
  // The company hears the decision — and nothing from the scorecards.
  const told = await prisma.notification.findMany({ where: { userId: companyUser.id, type: { startsWith: 'interview_panel.outcome' } } });
  expect(told).toHaveLength(1);
  expect(told[0].type).toBe('interview_panel.outcome.offer');
  expect(JSON.stringify(told[0].params)).not.toMatch(/score|divergence|spread/i);
  // Not asked for: the pipeline stage stays.
  expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe(beforePipeline);
  // Sealed once.
  const again = await admin.post(url, { data: offer });
  expect(again.status()).toBe(409);
  expect((await again.json()).code).toBe('outcome_recorded');
  expect((await (await admin.get(`/api/interview-panels/${panelId}`)).json()).panel.outcome).toBe('OFFER');
});

test('the active mentor may record the outcome, and the pipeline stage moves only on the explicit flag', async () => {
  const application = await prisma.application.create({
    data: { orgId: org.id, requisitionId: req2.id, menteeId: menteeUser.id, companyId: company.id, stage: 'INTERVIEW', status: 'ACTIVE', source: 'SHORTLIST' },
    select: { id: true },
  });
  const panel = await prisma.interviewPanel.create({
    data: { orgId: org.id, subjectId: menteeUser.id, title: 'Second round', closedAt: new Date(), createdById: adminUser.id, members: { create: [{ userId: adminUser.id }] } },
    select: { id: true },
  });
  const before = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id }, select: { pipelineStatus: true } });
  const statusChangesBefore = await prisma.statusChange.count({ where: { relationId: relation.id } });
  const advanced = await mentorCtx.post(`/api/interview-panels/${panel.id}/outcome`, { data: { decision: 'ADVANCE', applicationId: application.id, advancePipeline: true, note: 'strong round' } });
  expect(advanced.status()).toBe(200);
  const body = await advanced.json();
  expect(body.application.stage).toBe('OFFER');
  expect(body.pipeline).toMatchObject({ moved: true, from: before.pipelineStatus });
  expect(body.pipeline.to).not.toBe(before.pipelineStatus);
  const after = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id }, select: { pipelineStatus: true } });
  expect(after.pipelineStatus).toBe(body.pipeline.to);
  // The shared stage write path recorded the move.
  expect(await prisma.statusChange.count({ where: { relationId: relation.id } })).toBe(statusChangesBefore + 1);
  expect((await prisma.interviewPanel.findUniqueOrThrow({ where: { id: panel.id } })).outcome).toBe('ADVANCE');
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
