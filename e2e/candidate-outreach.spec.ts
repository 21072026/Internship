import { test, expect } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAndSettle, gotoSettled } from './helpers/auth';

// Company → candidate message requests (#1840): request → mentor approval →
// message delivered, plus every refusal the issue names — not shortlisted, no
// consent, a pending request delivers nothing, a decline reveals no reason,
// the quota, and the candidate's revoke with its 90-day block. Own org.

const PW = 'Outreach123!';

test.describe('candidate outreach', () => {
  const stamp = `${Date.now()}`;
  const companyEmail = uniqueEmail('or-company');
  const mentorEmail = uniqueEmail('or-mentor');
  const menteeEmail = uniqueEmail('or-mentee');
  const otherEmail = uniqueEmail('or-other');
  const quietEmail = uniqueEmail('or-quiet');
  const adminEmail = uniqueEmail('or-admin');
  let orgId = '';
  let companyId = '';

  test.beforeAll(async () => {
    orgId = (await prisma.organization.create({ data: { name: `OR Org ${stamp}`, slug: `or-${stamp}` } })).id;
    companyId = (await prisma.company.create({ data: { name: `Acme Hiring ${stamp}`, orgId } })).id;
    await prisma.user.create({
      data: { email: companyEmail, password: await bcrypt.hash(PW, 10), role: 'COMPANY', fullName: 'Acme Recruiter', companyId, orgId, skills: [] },
    });
    await seedUser(adminEmail, PW, 'ADMIN', `OR Admin ${stamp}`, orgId);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', `OR Mentor ${stamp}`, orgId);
    // Shortlisted + consented; shortlisted without consent; not shortlisted.
    for (const [email, name, shortlist, consent] of [
      [menteeEmail, 'Ada Candidate', true, true],
      [quietEmail, 'Quiet Candidate', true, false],
      [otherEmail, 'Other Candidate', false, true],
    ] as const) {
      const u = await seedUser(email, PW, 'MENTEE', name, orgId);
      await prisma.mentorshipRelation.create({ data: { orgId, mentorId: mentor.id, menteeId: u.id, companyId, status: 'ACTIVE' } });
      if (shortlist) await prisma.companyInterest.create({ data: { companyId, menteeId: u.id, status: 'SHORTLISTED' } });
      if (consent) await prisma.userConsent.create({ data: { userId: u.id, type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } });
    }
  });

  test.afterAll(async () => {
    await prisma.candidateOutreach.deleteMany({ where: { orgId } });
    await prisma.companyInterest.deleteMany({ where: { companyId } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId } });
    for (const email of [companyEmail, mentorEmail, menteeEmail, otherEmail, quietEmail, adminEmail]) await cleanupByEmail(email);
    await prisma.company.deleteMany({ where: { id: companyId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  test('request → mentor approval → delivered; refusals; decline; quota; revoke', async ({ browser }) => {
    test.setTimeout(240_000);
    const mentee = await prisma.user.findFirstOrThrow({ where: { email: menteeEmail, orgId } });
    const quiet = await prisma.user.findFirstOrThrow({ where: { email: quietEmail, orgId } });
    const other = await prisma.user.findFirstOrThrow({ where: { email: otherEmail, orgId } });
    const first = `Hello Ada, we loved your profile ${stamp}`;

    const company = await browser.newPage();
    await signInAndSettle(company, companyEmail, PW, '/company');

    // Not shortlisted → 404; no consent → 403.
    expect((await company.request.post('/api/company/outreach', { data: { menteeId: other.id, message: 'hi' } })).status()).toBe(404);
    const noConsent = await company.request.post('/api/company/outreach', { data: { menteeId: quiet.id, message: 'hi' } });
    expect(noConsent.status()).toBe(403);
    expect((await noConsent.json()).code).toBe('no_consent');

    // The request from the candidate page.
    await gotoSettled(company, `/company/candidates/${mentee.id}`);
    await company.getByTestId('outreach-compose').click();
    await company.getByTestId('outreach-message').fill(first);
    await company.getByTestId('outreach-send').click();
    await expect(company.getByTestId('outreach-request-status')).toContainText('Waiting for review');
    const row = await prisma.candidateOutreach.findFirstOrThrow({ where: { companyId, menteeId: mentee.id } });
    expect(row).toMatchObject({ status: 'PENDING', orgId, firstMessage: first });
    // A second request while pending is refused.
    expect((await company.request.post('/api/company/outreach', { data: { menteeId: mentee.id, message: 'again' } })).status()).toBe(409);

    // PENDING delivers nothing: no message, the candidate's list is empty.
    expect(await prisma.message.count({ where: { body: first } })).toBe(0);
    const candidate = await browser.newPage();
    await signInAndSettle(candidate, menteeEmail, PW, '/portal');
    expect((await (await candidate.request.get('/api/company/outreach')).json()).requests).toEqual([]);
    // The candidate cannot approve their own request.
    expect((await candidate.request.patch(`/api/company/outreach/${row.id}`, { data: { action: 'approve' } })).status()).toBe(403);
    // The mentor was told.
    const mentorUser = await prisma.user.findFirstOrThrow({ where: { email: mentorEmail, orgId } });
    expect(await prisma.notification.count({ where: { userId: mentorUser.id, type: 'outreach.requested' } })).toBe(1);

    // The mentor approves on /messages → the message is delivered.
    const mentor = await browser.newPage();
    await signInAndSettle(mentor, mentorEmail, PW, '/mentor');
    await gotoSettled(mentor, '/messages');
    await expect(mentor.getByTestId('outreach-panel')).toContainText(first);
    await mentor.getByTestId(`outreach-approve-${row.id}`).click();
    // The approval is complete once the stored message has been posted (and the row knows its thread).
    await expect.poll(async () => (await prisma.candidateOutreach.findUniqueOrThrow({ where: { id: row.id } })).conversationId, { timeout: 20_000 }).not.toBeNull();
    await expect.poll(async () => prisma.notification.count({ where: { userId: mentee.id, type: 'outreach.approvedCandidate' } })).toBe(1);
    const approved = await prisma.candidateOutreach.findUniqueOrThrow({ where: { id: row.id } });
    const delivered = await prisma.message.findFirstOrThrow({ where: { body: first } });
    expect(delivered.conversationId).toBe(approved.conversationId);
    const named = await prisma.notification.findFirstOrThrow({ where: { userId: mentee.id, type: 'outreach.approvedCandidate' } });
    expect((named.params as { company?: string }).company).toBe(`Acme Hiring ${stamp}`);
    // A second decision is refused.
    expect((await mentor.request.patch(`/api/company/outreach/${row.id}`, { data: { action: 'decline' } })).status()).toBe(409);

    // The company can now write into the thread.
    const reply = await company.request.post('/api/messages', { data: { conversationId: approved.conversationId, body: 'Follow-up' } });
    expect([200, 201]).toContain(reply.status());

    // The candidate revokes from /messages; the company can no longer post and cannot ask again.
    await gotoSettled(candidate, '/messages');
    await candidate.getByTestId(`outreach-revoke-${row.id}`).click();
    await expect.poll(async () => (await prisma.candidateOutreach.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('REVOKED');
    const blocked = await company.request.post('/api/messages', { data: { conversationId: approved.conversationId, body: 'Still there?' } });
    expect(blocked.ok()).toBe(false);
    const again = await company.request.post('/api/company/outreach', { data: { menteeId: mentee.id, message: 'Please' } });
    expect(again.status()).toBe(409);
    expect((await again.json()).code).toBe('cooldown');
    const companyList = (await (await company.request.get('/api/company/outreach')).json()).requests;
    expect(companyList[0]).toEqual(expect.objectContaining({ status: 'CLOSED' }));
    expect(companyList[0]).not.toHaveProperty('decidedById');

    // Decline reveals nothing: the "quiet" candidate opts in, the company asks, an admin declines.
    await prisma.userConsent.create({ data: { userId: quiet.id, type: 'TALENT_POOL_VISIBILITY', grantedAt: new Date() } });
    const q = await company.request.post('/api/company/outreach', { data: { menteeId: quiet.id, message: 'Hi Quiet' } });
    expect(q.status()).toBe(201);
    const qid = (await q.json()).request.id;
    const admin = await browser.newPage();
    await signInAndSettle(admin, adminEmail, PW, '/admin');
    expect((await admin.request.patch(`/api/company/outreach/${qid}`, { data: { action: 'decline' } })).status()).toBe(200);
    const declined = (await (await company.request.get('/api/company/outreach')).json()).requests.find((r: { id: string }) => r.id === qid);
    expect(declined).toEqual({ id: qid, menteeId: quiet.id, status: 'DECLINED', createdAt: expect.any(String), decidedAt: expect.any(String), menteeName: 'Quiet Candidate' });
    expect(await prisma.message.count({ where: { body: 'Hi Quiet' } })).toBe(0);

    // Quota: with a limit of 1 (one approval this month already), the next request is refused with limit + used.
    await prisma.company.update({ where: { id: companyId }, data: { quota: 1 } });
    const over = await company.request.post('/api/company/outreach', { data: { menteeId: quiet.id, message: 'Hi again' } });
    expect(over.status()).toBe(403);
    expect(await over.json()).toMatchObject({ code: 'quota_exceeded', limit: 1, used: 1 });

    for (const p of [company, candidate, mentor, admin]) await p.close();
  });
});
