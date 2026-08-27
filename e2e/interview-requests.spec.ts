import { test, expect, type Page } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, uniqueEmail } from './helpers/db';
import { submitSignInForm } from './helpers/auth';
import { companyInterestScopeKey } from '@/lib/companyInterests';

const stamp = `${Date.now()}-${Math.round(Math.random() * 10000)}`;
const password = 'InterviewPass123!';
const emails = {
  adminA: uniqueEmail('int-admin-a'), adminB: uniqueEmail('int-admin-b'), companyA: uniqueEmail('int-company-a'),
  companyB: uniqueEmail('int-company-b'), companyNull: uniqueEmail('int-company-null'), mentorA: uniqueEmail('int-mentor-a'),
  mentorOther: uniqueEmail('int-mentor-other'), mentee: uniqueEmail('int-mentee'),
};
let orgA: { id: string }; let orgB: { id: string }; let companyA: { id: string }; let companyB: { id: string };
let adminA: { id: string }; let mentorA: { id: string }; let mentee: { id: string };
let relation: { id: string; pipelineStatus: string }; let reqA: { id: string }; let reqB: { id: string };

// This spec re-signs in as a different role many times on the SAME `page`
// (see the calls below), which a bare `clearCookies()` + `goto` + `fill` +
// `click` cannot do reliably: the outgoing page keeps talking to
// /api/auth/session and re-issues the session cookie, so /auth/signin can see
// `authenticated` and router.replace() to the *previous* user's dashboard
// mid-fill — detaching the submit button Playwright is about to click. Reuse
// the shared helper (helpers/auth.ts) instead of duplicating that race here.
async function login(page: Page, email: string) {
  await submitSignInForm(page, email, password);
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/signin'));
}

test.describe.serial('Story #807 shortlist and interview requests', () => {
  test.beforeAll(async () => {
    const hash = await bcrypt.hash(password, 10);
    orgA = await prisma.organization.create({ data: { name: `Interview A ${stamp}`, slug: `interview-a-${stamp}` } });
    orgB = await prisma.organization.create({ data: { name: `Interview B ${stamp}`, slug: `interview-b-${stamp}` } });
    companyA = await prisma.company.create({ data: { name: `Interview Co A ${stamp}`, orgId: orgA.id } });
    companyB = await prisma.company.create({ data: { name: `Interview Co B ${stamp}`, orgId: orgB.id } });
    const user = (email: string, role: 'ADMIN' | 'COMPANY' | 'MENTOR' | 'MENTEE', orgId: string, companyId?: string, preferredLanguage?: string) => prisma.user.create({ data: { email, password: hash, role, fullName: email.split('@')[0], orgId, companyId, preferredLanguage, skills: [] } });
    adminA = await user(emails.adminA, 'ADMIN', orgA.id); await user(emails.adminB, 'ADMIN', orgB.id);
    await user(emails.companyA, 'COMPANY', orgA.id, companyA.id); await user(emails.companyB, 'COMPANY', orgB.id, companyB.id); await user(emails.companyNull, 'COMPANY', orgA.id);
    mentorA = await user(emails.mentorA, 'MENTOR', orgA.id); await user(emails.mentorOther, 'MENTOR', orgA.id);
    mentee = await user(emails.mentee, 'MENTEE', orgA.id, undefined, 'tr');
    relation = await prisma.mentorshipRelation.create({ data: { orgId: orgA.id, companyId: companyA.id, mentorId: mentorA.id, menteeId: mentee.id, status: 'ACTIVE', pipelineStatus: 'APPLICATION_100' } });
    reqA = await prisma.requisition.create({ data: { orgId: orgA.id, companyId: companyA.id, title: `Req A ${stamp}`, openings: 1, requiredSkills: [] } });
    reqB = await prisma.requisition.create({ data: { orgId: orgB.id, companyId: companyB.id, title: `Req B ${stamp}`, openings: 1, requiredSkills: [] } });
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { userId: mentee?.id } }).catch(() => {}); await prisma.auditLog.deleteMany({ where: { actorId: { in: [adminA?.id, mentorA?.id].filter(Boolean) } } }).catch(() => {});
    await prisma.interviewRequest.deleteMany({ where: { menteeId: mentee?.id } }).catch(() => {}); await prisma.companyInterest.deleteMany({ where: { menteeId: mentee?.id } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { id: relation?.id } }).catch(() => {}); await prisma.requisition.deleteMany({ where: { id: { in: [reqA?.id, reqB?.id].filter(Boolean) } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: Object.values(emails) } } }).catch(() => {}); await prisma.company.deleteMany({ where: { id: { in: [companyA?.id, companyB?.id].filter(Boolean) } } }).catch(() => {}); await prisma.organization.deleteMany({ where: { id: { in: [orgA?.id, orgB?.id].filter(Boolean) } } }).catch(() => {}); await prisma.$disconnect();
  });

  test('companyId-null COMPANY fails closed before shortlist/interview/requisition access', async ({ page }) => {
    await login(page, emails.companyNull);
    for (const response of [
      await page.request.get(`/api/company/interests?requisitionId=${reqA.id}`), await page.request.post('/api/company/interests', { data: { menteeId: mentee.id, status: 'SHORTLISTED' } }),
      await page.request.get('/api/interview-requests'), await page.request.get('/api/mentorship'),
      await page.request.post('/api/interview-requests', { data: { requisitionId: reqA.id, menteeId: mentee.id } }), await page.request.get(`/api/requisitions/${reqA.id}`),
    ]) { expect(response.status()).toBe(403); expect((await response.json()).code).toBe('company_not_assigned'); }
  });

  test('company cannot cross company/org and request body cannot grant authority', async ({ page }) => {
    await login(page, emails.companyA);
    expect((await page.request.post('/api/company/interests', { data: { menteeId: mentee.id, requisitionId: reqB.id, status: 'SHORTLISTED', companyId: companyA.id, orgId: orgA.id } })).status()).toBe(400);
    expect((await page.request.get(`/api/company/interests?requisitionId=${reqB.id}`)).status()).toBe(404);
    expect((await page.request.post('/api/interview-requests', { data: { requisitionId: reqB.id, menteeId: mentee.id } })).status()).toBe(404);
    expect((await page.request.post('/api/interview-requests', { data: { requisitionId: reqA.id, menteeId: mentee.id, companyId: companyA.id, orgId: orgA.id } })).status()).toBe(400);
    const foreignRequest = await prisma.interviewRequest.create({ data: { orgId: orgB.id, companyId: companyB.id, requisitionId: reqB.id, menteeId: mentee.id } });
    try {
      expect((await page.request.get(`/api/interview-requests?requisitionId=${reqB.id}`)).status()).toBe(404);
    } finally {
      await prisma.interviewRequest.delete({ where: { id: foreignRequest.id } });
    }
  });

  test('legacy interest remains valid and requisition-linked shortlist creates PENDING request', async ({ page }) => {
    const legacy = await prisma.companyInterest.create({ data: { companyId: companyA.id, menteeId: mentee.id, scopeKey: companyInterestScopeKey(companyA.id, mentee.id), status: 'INTERESTED' } });
    await login(page, emails.companyA);
    const shortlist = await page.request.post('/api/company/interests', { data: { menteeId: mentee.id, requisitionId: reqA.id, status: 'SHORTLISTED' } });
    expect(shortlist.status()).toBe(200); expect((await shortlist.json()).interest.requisitionId).toBe(reqA.id);
    expect(await prisma.companyInterest.count({ where: { id: legacy.id, requisitionId: null } })).toBe(1);
    const legacyRead = await (await page.request.get(`/api/company/interests?menteeId=${mentee.id}`)).json();
    expect(legacyRead.interest.id).toBe(legacy.id);
    const created = await page.request.post('/api/interview-requests', { data: { requisitionId: reqA.id, menteeId: mentee.id, proposedSlots: ['2026-09-01T10:00:00.000Z'] } });
    expect(created.status()).toBe(201); expect((await created.json()).request.status).toBe('PENDING');
    expect((await page.request.post('/api/interview-requests', { data: { requisitionId: reqA.id, menteeId: mentee.id } })).status()).toBe(409);
  });

  test('scopeKey enforces legacy and requisition uniqueness without collapsing history', async () => {
    const legacyKey = companyInterestScopeKey(companyA.id, mentee.id);
    const requisitionKey = companyInterestScopeKey(companyA.id, mentee.id, reqA.id);
    await expect(prisma.companyInterest.create({ data: { companyId: companyA.id, menteeId: mentee.id, scopeKey: legacyKey, status: 'PASS' } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.companyInterest.create({ data: { companyId: companyA.id, menteeId: mentee.id, requisitionId: reqA.id, scopeKey: requisitionKey, status: 'PASS' } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.companyInterest.count({ where: { companyId: companyA.id, menteeId: mentee.id } })).toBe(2);
    await expect(prisma.requisition.delete({ where: { id: reqA.id } })).rejects.toMatchObject({ code: 'P2003' });
    expect(await prisma.companyInterest.count({ where: { companyId: companyA.id, menteeId: mentee.id } })).toBe(2);
  });

  test('unrelated mentor and mentee cannot decide; assigned mentor approval audits, localizes, and leaves pipeline unchanged', async ({ page }) => {
    const pending = await prisma.interviewRequest.findFirstOrThrow({ where: { requisitionId: reqA.id, menteeId: mentee.id, status: 'PENDING' } });
    await login(page, emails.mentorOther); expect((await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'approve' } })).status()).toBe(404);
    await login(page, emails.mentee); expect((await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'approve' } })).status()).toBe(403);
    const meetingsBefore = await prisma.meeting.count({ where: { relationId: relation.id } });
    await login(page, emails.mentorA); const approved = await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'approve' } });
    expect(approved.status()).toBe(200); expect((await approved.json()).pipelineRecommendation).toBe('INTERVIEW_PENDING_250');
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } })).pipelineStatus).toBe('APPLICATION_100');
    expect(await prisma.meeting.count({ where: { relationId: relation.id } })).toBe(meetingsBefore);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: pending.id, action: 'INTERVIEW_REQUEST_DECIDED' } });
    expect(audit.actorId).toBe(mentorA.id); expect(audit.targetId).toBe(pending.id); expect(audit.detail).toContain(reqA.id); expect(audit.detail).toContain(mentee.id); expect(audit.detail).toContain('APPROVED');
    const notifications = await prisma.notification.findMany({ where: { userId: mentee.id, type: 'interview_request.approved' } }); expect(notifications).toHaveLength(1);
    expect((await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'decline' } })).status()).toBe(409);
    expect(await prisma.auditLog.count({ where: { targetId: pending.id, action: 'INTERVIEW_REQUEST_DECIDED' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.approved' } })).toBe(1);
    await login(page, emails.companyA);
    const next = await page.request.post('/api/interview-requests', { data: { requisitionId: reqA.id, menteeId: mentee.id } });
    expect(next.status()).toBe(201);
    await prisma.interviewRequest.delete({ where: { id: (await next.json()).request.id } });
  });

  test('decline creates one audit and no mentee notification', async ({ page }) => {
    await prisma.companyInterest.updateMany({ where: { companyId: companyA.id, menteeId: mentee.id, requisitionId: reqA.id }, data: { status: 'SHORTLISTED' } });
    const pending = await prisma.interviewRequest.create({ data: { orgId: orgA.id, companyId: companyA.id, requisitionId: reqA.id, menteeId: mentee.id, status: 'PENDING', activeKey: `${reqA.id}:${mentee.id}:decline` } });
    const before = await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.approved' } });
    await login(page, emails.adminA); const declined = await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'decline', note: 'Not now' } }); expect(declined.status()).toBe(200);
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.approved' } })).toBe(before);
    expect((await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'decline' } })).status()).toBe(409);
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.approved' } })).toBe(before);
    expect(await prisma.auditLog.count({ where: { targetId: pending.id } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { targetId: pending.id } });
    expect(audit.actorId).toBe(adminA.id); expect(audit.targetId).toBe(pending.id); expect(audit.detail).toContain(reqA.id); expect(audit.detail).toContain(mentee.id); expect(audit.detail).toContain('DECLINED');
  });

  test('concurrent approve/decline has one winner and one audit', async ({ page }) => {
    const pending = await prisma.interviewRequest.create({ data: { orgId: orgA.id, companyId: companyA.id, requisitionId: reqA.id, menteeId: mentee.id, activeKey: `${reqA.id}:${mentee.id}:race` } });
    await login(page, emails.adminA);
    const invalid = await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'approve', status: 'SCHEDULED' } });
    expect(invalid.status()).toBe(400);
    expect((await prisma.interviewRequest.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PENDING');
    const notificationsBefore = await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.approved' } });
    const results = await Promise.all([
      page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'approve' } }),
      page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'decline' } }),
    ]);
    expect(results.filter((result) => result.status() === 200)).toHaveLength(1); expect(results.filter((result) => result.status() === 409)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { targetId: pending.id } })).toBe(1);
    const decided = await prisma.interviewRequest.findUniqueOrThrow({ where: { id: pending.id } });
    const notificationsAfter = await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.approved' } });
    expect(notificationsAfter - notificationsBefore).toBe(decided.status === 'APPROVED' ? 1 : 0);
    expect((await page.request.patch(`/api/interview-requests/${pending.id}`, { data: { action: 'approve' } })).status()).toBe(409);
    expect(await prisma.auditLog.count({ where: { targetId: pending.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: mentee.id, type: 'interview_request.approved' } })).toBe(notificationsAfter);
  });

  test('admin cannot inspect or decide another tenant request', async ({ page }) => {
    const foreignMentee = await prisma.user.create({ data: { email: uniqueEmail('foreign-int-mentee'), password: 'x', role: 'MENTEE', fullName: 'Foreign', orgId: orgB.id, skills: [] } });
    const foreign = await prisma.interviewRequest.create({ data: { orgId: orgB.id, companyId: companyB.id, requisitionId: reqB.id, menteeId: foreignMentee.id } });
    try { await login(page, emails.adminA); expect((await page.request.patch(`/api/interview-requests/${foreign.id}`, { data: { action: 'approve' } })).status()).toBe(404); const list = await (await page.request.get('/api/interview-requests')).json(); expect(list.requests.some((item: { id: string }) => item.id === foreign.id)).toBe(false); }
    finally { await prisma.interviewRequest.deleteMany({ where: { id: foreign.id } }); await prisma.user.delete({ where: { id: foreignMentee.id } }); }
  });

  test('company cannot decide an interview request', async ({ page }) => {
    const request = await prisma.interviewRequest.create({
      data: { orgId: orgB.id, companyId: companyB.id, requisitionId: reqB.id, menteeId: mentee.id, activeKey: `${reqB.id}:${mentee.id}:company-decision` },
    });
    try {
      await login(page, emails.companyA);
      expect((await page.request.patch(`/api/interview-requests/${request.id}`, { data: { action: 'approve' } })).status()).toBe(403);
    } finally {
      await prisma.interviewRequest.deleteMany({ where: { id: request.id } });
    }
  });
});
