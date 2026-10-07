import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  cleanupByEmail,
  cleanupMenteeWithRelation,
  prisma,
  seedMenteeWithRelation,
  seedUser,
  uniqueEmail,
  type SeededRelation,
} from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { defaultOrgId } from '../src/lib/defaultOrg';
import { statusForStage, type ApplicationStage } from '../src/lib/applications';

// Application stage transitions (#1836): the write half of the per-role funnel.
// Everything here is decided by the server — who may move what is read from
// the database, the legal path is canTransition(), a rejection needs a reason
// code, and a stale caller gets a 409 rather than a lost update. The company
// shortlist and the interview approval write through to the same row.

const PW = 'Pipeline123!';
let org: string;
let pair: SeededRelation;
let companyB: { id: string };
let otherMenteeId = '';
let companyAUserId = '';
let adminUserId = '';
const emails = {
  admin: uniqueEmail('pipeline-admin'),
  companyA: uniqueEmail('pipeline-company-a'),
  companyB: uniqueEmail('pipeline-company-b'),
  otherMentee: uniqueEmail('pipeline-other-mentee'),
};
let admin: APIRequestContext;
let companyA: APIRequestContext;
let companyBCtx: APIRequestContext;
let mentee: APIRequestContext;
let reqA: { id: string };
let reqA2: { id: string };
let reqA3: { id: string };
let reqB: { id: string };
let app1Id = '';
let rejectedId = '';

test.describe.configure({ mode: 'serial' });

function mkApp(menteeId: string, requisitionId: string, companyId: string, stage: ApplicationStage = 'APPLIED') {
  return prisma.application.create({
    data: { orgId: org, requisitionId, menteeId, companyId, stage, status: statusForStage(stage) },
    select: { id: true },
  });
}

test.beforeAll(async ({ playwright }, info) => {
  org = await defaultOrgId();
  pair = await seedMenteeWithRelation('pipeline', PW);
  // The seeded pair is org-less on purpose elsewhere; the funnel is tenant-scoped.
  await prisma.company.update({ where: { id: pair.companyId }, data: { orgId: org } });
  await prisma.mentorshipRelation.update({ where: { id: pair.relationId }, data: { orgId: org } });
  await prisma.user.updateMany({ where: { id: { in: [pair.mentorId, pair.menteeId] } }, data: { orgId: org } });
  companyB = await prisma.company.create({ data: { name: `pipeline Co B ${Date.now()}`, orgId: org }, select: { id: true } });
  const adminUser = await seedUser(emails.admin, PW, 'ADMIN', 'Pipeline Admin');
  adminUserId = adminUser.id;
  const companyAUser = await seedUser(emails.companyA, PW, 'COMPANY', 'Pipeline Company A');
  companyAUserId = companyAUser.id;
  const companyBUser = await seedUser(emails.companyB, PW, 'COMPANY', 'Pipeline Company B');
  const otherMentee = await seedUser(emails.otherMentee, PW, 'MENTEE', 'Pipeline Other Mentee');
  otherMenteeId = otherMentee.id;
  await prisma.user.update({ where: { id: adminUser.id }, data: { orgId: org } });
  await prisma.user.update({ where: { id: companyAUser.id }, data: { orgId: org, companyId: pair.companyId } });
  await prisma.user.update({ where: { id: companyBUser.id }, data: { orgId: org, companyId: companyB.id } });
  await prisma.user.update({ where: { id: otherMentee.id }, data: { orgId: org } });
  const mkReq = (companyId: string, title: string) =>
    prisma.requisition.create({ data: { orgId: org, companyId, title, status: 'OPEN', openings: 1, requiredSkills: [] }, select: { id: true } });
  reqA = await mkReq(pair.companyId, `Pipeline A ${Date.now()}`);
  reqA2 = await mkReq(pair.companyId, `Pipeline A2 ${Date.now()}`);
  reqA3 = await mkReq(pair.companyId, `Pipeline A3 ${Date.now()}`);
  reqB = await mkReq(companyB.id, `Pipeline B ${Date.now()}`);

  const baseURL = info.project.use.baseURL;
  [admin, companyA, companyBCtx, mentee] = await Promise.all([1, 2, 3, 4].map(() => playwright.request.newContext({ baseURL })));
  expect((await signInViaApi(admin, emails.admin, PW)).ok).toBe(true);
  expect((await signInViaApi(companyA, emails.companyA, PW)).ok).toBe(true);
  expect((await signInViaApi(companyBCtx, emails.companyB, PW)).ok).toBe(true);
  expect((await signInViaApi(mentee, pair.menteeEmail, PW)).ok).toBe(true);
});

test.afterAll(async () => {
  await Promise.all([admin, companyA, companyBCtx, mentee].map((c) => c?.dispose()));
  const reqIds = [reqA, reqA2, reqA3, reqB].filter(Boolean).map((r) => r.id);
  await prisma.application.deleteMany({ where: { requisitionId: { in: reqIds } } }).catch(() => {});
  await prisma.interviewRequest.deleteMany({ where: { requisitionId: { in: reqIds } } }).catch(() => {});
  await prisma.companyInterest.deleteMany({ where: { requisitionId: { in: reqIds } } }).catch(() => {});
  await prisma.requisition.deleteMany({ where: { id: { in: reqIds } } }).catch(() => {});
  for (const email of Object.values(emails)) await cleanupByEmail(email);
  if (pair) await cleanupMenteeWithRelation(pair);
  if (companyB) await prisma.company.delete({ where: { id: companyB.id } }).catch(() => {});
});

test('a company moves only its own applicants, along the legal path, and a stale caller gets a 409', { tag: '@smoke' }, async () => {
  const app = await mkApp(pair.menteeId, reqA.id, pair.companyId);
  app1Id = app.id;
  const url = `/api/applications/${app.id}/stage`;
  // Another company's requisition: not found, never "forbidden" (that would confirm the id).
  expect((await companyBCtx.patch(url, { data: { toStage: 'SHORTLISTED', expectedStage: 'APPLIED' } })).status()).toBe(404);
  // The legal path is the server's, not the screen's.
  const jump = await companyA.patch(url, { data: { toStage: 'HIRED', expectedStage: 'APPLIED' } });
  expect(jump.status()).toBe(400);
  expect((await jump.json()).code).toBe('invalid_transition');
  const ok = await companyA.patch(url, { data: { toStage: 'SHORTLISTED', expectedStage: 'APPLIED', note: 'strong CV' } });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(body.application.stage).toBe('SHORTLISTED');
  expect(body.application.status).toBe('ACTIVE');
  expect(body.application).not.toHaveProperty('dispositionNote');
  // A company screens, shortlists and rejects — interviews are the programme's.
  const interview = await companyA.patch(url, { data: { toStage: 'INTERVIEW', expectedStage: 'SHORTLISTED' } });
  expect(interview.status()).toBe(403);
  expect((await interview.json()).code).toBe('forbidden_transition');
  // Exactly one event and one activity row for the one change.
  const events = await prisma.applicationEvent.findMany({ where: { applicationId: app.id } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ fromStage: 'APPLIED', toStage: 'SHORTLISTED', actorId: companyAUserId, note: 'strong CV' });
  expect(await prisma.activityLog.count({ where: { action: 'application.stage.set', targetId: app.id } })).toBe(1);
  // A stale expectedStage answers 409 and changes nothing.
  const stale = await admin.patch(url, { data: { toStage: 'INTERVIEW', expectedStage: 'APPLIED' } });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).code).toBe('stage_conflict');
  expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).stage).toBe('SHORTLISTED');
});

test('two concurrent moves yield one success and one 409; a rejection needs a disposition code', async () => {
  const app = await mkApp(pair.menteeId, reqA2.id, pair.companyId);
  rejectedId = app.id;
  const url = `/api/applications/${app.id}/stage`;
  const move = { data: { toStage: 'SCREENING', expectedStage: 'APPLIED' } };
  const [a, b] = await Promise.all([admin.patch(url, move), admin.patch(url, move)]);
  expect([a.status(), b.status()].sort()).toEqual([200, 409]);
  expect(await prisma.applicationEvent.count({ where: { applicationId: app.id } })).toBe(1);

  const noCode = await admin.patch(url, { data: { toStage: 'REJECTED', expectedStage: 'SCREENING' } });
  expect(noCode.status()).toBe(400);
  expect((await noCode.json()).code).toBe('disposition_required');
  const badCode = await admin.patch(url, { data: { toStage: 'REJECTED', expectedStage: 'SCREENING', dispositionCode: 'VIBES' } });
  expect(badCode.status()).toBe(400);
  const rejected = await admin.patch(url, { data: { toStage: 'REJECTED', expectedStage: 'SCREENING', dispositionCode: 'SKILLS', note: 'no Kotlin' } });
  expect(rejected.status()).toBe(200);
  const body = await rejected.json();
  expect(body.application).toMatchObject({ stage: 'REJECTED', status: 'REJECTED', dispositionCode: 'SKILLS' });
  expect(body.application.decidedAt).not.toBeNull();
  const row = await prisma.application.findUniqueOrThrow({ where: { id: app.id } });
  expect(row.dispositionNote).toBe('no Kotlin');
  expect(await prisma.applicationEvent.count({ where: { applicationId: app.id } })).toBe(2);
  expect(await prisma.activityLog.count({ where: { action: 'application.stage.set', targetId: app.id } })).toBe(2);
  // Terminal: nothing moves out of REJECTED.
  const reopen = await admin.patch(url, { data: { toStage: 'SHORTLISTED', expectedStage: 'REJECTED' } });
  expect(reopen.status()).toBe(400);
  expect((await reopen.json()).code).toBe('invalid_transition');
});

test('a mentee may only withdraw their own application, and never reads a reason back', async () => {
  const own = await mkApp(pair.menteeId, reqB.id, companyB.id);
  const url = `/api/applications/${own.id}/stage`;
  const shortlist = await mentee.patch(url, { data: { toStage: 'SHORTLISTED', expectedStage: 'APPLIED' } });
  expect(shortlist.status()).toBe(403);
  const withdrawn = await mentee.patch(url, { data: { toStage: 'WITHDRAWN', expectedStage: 'APPLIED' } });
  expect(withdrawn.status()).toBe(200);
  const body = await withdrawn.json();
  expect(body.application).toMatchObject({ stage: 'WITHDRAWN', status: 'WITHDRAWN', dispositionCode: null });
  expect(body.application.withdrawnAt).not.toBeNull();
  const foreign = await mkApp(otherMenteeId, reqA.id, pair.companyId);
  expect((await mentee.patch(`/api/applications/${foreign.id}/stage`, { data: { toStage: 'WITHDRAWN', expectedStage: 'APPLIED' } })).status()).toBe(404);
  expect((await mentee.get('/api/company/applications')).status()).toBe(403);
});

test('bulk moves report every skipped row with its reason and never over-report', async () => {
  const b1 = await mkApp(otherMenteeId, reqA2.id, pair.companyId);
  const hired = await mkApp(otherMenteeId, reqB.id, companyB.id, 'HIRED');
  const res = await companyA.post('/api/applications/bulk-stage', {
    data: { ids: [b1.id, hired.id, app1Id, 'nope-does-not-exist'], toStage: 'SCREENING' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.moved).toEqual([b1.id]);
  expect(body.skipped).toEqual([
    { id: hired.id, reason: 'not_found' }, // another company's — invisible, not "forbidden"
    { id: app1Id, reason: 'invalid_transition' }, // already SHORTLISTED; the funnel does not go back
    { id: 'nope-does-not-exist', reason: 'not_found' },
  ]);
  expect((await prisma.application.findUniqueOrThrow({ where: { id: b1.id } })).stage).toBe('SCREENING');
  expect((await prisma.application.findUniqueOrThrow({ where: { id: hired.id } })).stage).toBe('HIRED');
  expect(await prisma.activityLog.count({ where: { action: 'application.stage.set', targetId: b1.id } })).toBe(1);
  // The limits are the server's too.
  const tooMany = await companyA.post('/api/applications/bulk-stage', { data: { ids: Array.from({ length: 51 }, (_, i) => `id-${i}`), toStage: 'SCREENING' } });
  expect(tooMany.status()).toBe(400);
  const noReason = await companyA.post('/api/applications/bulk-stage', { data: { ids: [b1.id], toStage: 'REJECTED' } });
  expect(noReason.status()).toBe(400);
  expect((await noReason.json()).code).toBe('disposition_required');
});

test('a company shortlist creates the application, an approved interview moves it, a pass rejects it', async () => {
  const shortlist = await companyA.post('/api/company/interests', { data: { menteeId: pair.menteeId, status: 'SHORTLISTED', requisitionId: reqA3.id } });
  expect(shortlist.status()).toBe(200);
  const key = { requisitionId_menteeId: { requisitionId: reqA3.id, menteeId: pair.menteeId } };
  const created = await prisma.application.findUniqueOrThrow({ where: key, include: { events: true } });
  expect(created).toMatchObject({ stage: 'SHORTLISTED', status: 'ACTIVE', source: 'SHORTLIST', companyId: pair.companyId, orgId: org });
  expect(created.events).toHaveLength(1);
  expect(created.events[0]).toMatchObject({ fromStage: null, toStage: 'SHORTLISTED', actorId: companyAUserId });
  // Flagging the same thing twice is a no-op, not a second event.
  expect((await companyA.post('/api/company/interests', { data: { menteeId: pair.menteeId, status: 'SHORTLISTED', requisitionId: reqA3.id, note: 'still' } })).status()).toBe(200);
  expect(await prisma.applicationEvent.count({ where: { applicationId: created.id } })).toBe(1);

  const asked = await companyA.post('/api/interview-requests', { data: { requisitionId: reqA3.id, menteeId: pair.menteeId } });
  expect([200, 201]).toContain(asked.status());
  const request = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: reqA3.id, menteeId: pair.menteeId }, select: { id: true } });
  const approved = await admin.patch(`/api/interview-requests/${request.id}`, { data: { action: 'approve' } });
  expect(approved.status()).toBe(200);
  const afterApproval = await prisma.application.findUniqueOrThrow({ where: key, include: { events: { orderBy: { createdAt: 'asc' } } } });
  expect(afterApproval.stage).toBe('INTERVIEW');
  expect(afterApproval.events).toHaveLength(2);
  expect(afterApproval.events[1]).toMatchObject({ fromStage: 'SHORTLISTED', toStage: 'INTERVIEW', actorId: adminUserId });
  expect(await prisma.activityLog.count({ where: { action: 'application.stage.set', targetId: created.id } })).toBe(2);

  const passed = await companyA.post('/api/company/interests', { data: { menteeId: pair.menteeId, status: 'PASS', requisitionId: reqA3.id, note: 'went with another candidate' } });
  expect(passed.status()).toBe(200);
  const afterPass = await prisma.application.findUniqueOrThrow({ where: key });
  expect(afterPass).toMatchObject({ stage: 'REJECTED', status: 'REJECTED', dispositionCode: 'OTHER', dispositionNote: 'went with another candidate' });
  expect(afterPass.decidedAt).not.toBeNull();
});

test('rediscovery: past applicants surface by disposition code, scoped to the company', async () => {
  const mine = await companyA.get('/api/company/applications?stage=REJECTED&dispositionCode=SKILLS');
  expect(mine.status()).toBe(200);
  const { applications } = await mine.json();
  expect(applications.map((a: { id: string }) => a.id)).toContain(rejectedId);
  for (const a of applications) {
    expect(a.requisition.companyId).toBe(pair.companyId);
    expect(a.stage).toBe('REJECTED');
    expect(a.dispositionCode).toBe('SKILLS');
  }
  const theirs = await companyBCtx.get('/api/company/applications?stage=REJECTED');
  expect(theirs.status()).toBe(200);
  expect((await theirs.json()).applications.map((a: { id: string }) => a.id)).not.toContain(rejectedId);
  expect((await companyA.get('/api/company/applications?stage=BOGUS')).status()).toBe(400);
  expect((await companyA.get('/api/company/applications?dispositionCode=VIBES')).status()).toBe(400);
  expect((await companyA.get('/api/company/applications?since=not-a-date')).status()).toBe(400);
  // An admin sees the org and may narrow to one company.
  const adminView = await admin.get(`/api/company/applications?companyId=${companyB.id}`);
  expect(adminView.status()).toBe(200);
  const rows = (await adminView.json()).applications as { requisition: { companyId: string } }[];
  expect(rows.length).toBeGreaterThan(0);
  for (const a of rows) expect(a.requisition.companyId).toBe(companyB.id);
});
