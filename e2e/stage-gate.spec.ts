import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInAsFreshUser } from './helpers/auth';

// Stage entry gates (#1589). A tenant configures, per stage, what must hold
// before a relation moves FORWARD into it; canTransition() (src/lib/stageGate.ts)
// is asked before the write on the board/candidate PUT, the bulk advance (per
// row) and the public API. This spec proves:
//   · a missing mandatory document blocks the move with a 409 naming it, and
//     the same move passes once the document exists;
//   · a capability gate stops a mentor and lets an admin through;
//   · a backwards move is never gated;
//   · the bulk advance reports the blocked row and moves the rest;
//   · an org with no gate configured is unaffected.

test.afterAll(async () => prisma.$disconnect());

const PW = 'StageGate123!';

test('a gated stage refuses a forward move until its conditions hold', { tag: '@smoke' }, async ({ page, browser }) => {
  test.setTimeout(120_000);
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Gate ${s}`, slug: `gate-${s}` } });
  const emails = ['sg-admin', 'sg-mentor', 'sg-mentee', 'sg-mentee2', 'sg-other-admin', 'sg-other-mentor', 'sg-other-mentee'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, menteeEmail, mentee2Email, otherAdminEmail, otherMentorEmail, otherMenteeEmail] = emails;
  const otherOrg = await prisma.organization.create({ data: { name: `NoGate ${s}`, slug: `nogate-${s}` } });
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Gate Admin', org.id);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Gate Mentor', org.id);
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Gate Mentee', org.id);
    const mentee2 = await seedUser(mentee2Email, PW, 'MENTEE', 'Gate Mentee Two', org.id);

    await prisma.pipelineStage.createMany({
      data: [
        { orgId: org.id, key: 'APPLICATION_100', label: '', order: 0 },
        { orgId: org.id, key: 'APPROVAL_PENDING_220', label: '', order: 1, gateDocuments: true },
        { orgId: org.id, key: 'INTERVIEW_PENDING_250', label: '', order: 2, gateCapability: 'pipeline.transition' },
        { orgId: org.id, key: 'INTERNSHIP_DROPPED_460', label: '', order: 3, isOffPath: true },
      ],
    });
    const requirement = await prisma.documentRequirement.create({
      data: { orgId: org.id, key: 'signed-agreement', labels: { en: 'Signed agreement', tr: 'İmzalı sözleşme', de: 'Unterschriebene Vereinbarung' }, appliesToStage: 'APPROVAL_PENDING_220', appliesToRole: 'MENTEE' },
    });
    const relation = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee.id } });
    const relation2 = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId: mentee2.id } });
    const stageOf = async (id: string) => (await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id } })).pipelineStatus;

    await signInAsFreshUser(page, adminEmail, PW, '/admin');

    // 1. Blocked: the mandatory document of the target stage is missing.
    const blocked = await page.request.put(`/api/mentorship/${relation.id}`, { data: { pipelineStatus: 'APPROVAL_PENDING_220' } });
    expect(blocked.status()).toBe(409);
    const body = await blocked.json();
    expect(body.error).toBe('stage_gate_blocked');
    expect(body.gate.code).toBe('documents');
    expect(body.gate.missing).toEqual([{ key: 'signed-agreement', label: expect.any(String) }]);
    expect(await stageOf(relation.id)).toBe('APPLICATION_100');
    expect(await prisma.statusChange.count({ where: { relationId: relation.id } })).toBe(0);

    // 2. The bulk advance: the row without the document is reported, nothing fails.
    await prisma.document.create({
      data: { ownerId: mentee2.id, uploaderId: mentee2.id, requirementId: requirement.id, type: 'OTHER', title: 'Agreement', filename: 'a.pdf', contentType: 'application/pdf', size: 8, data: Buffer.from('%PDF-1.4') },
    });
    const bulk = await page.request.post('/api/admin/candidates/bulk', { data: { candidateIds: [mentee.id, mentee2.id], action: 'advanceStage' } });
    expect(bulk.ok()).toBeTruthy();
    const bulkBody = await bulk.json();
    expect(bulkBody.advanced).toBe(1);
    expect(bulkBody.reasons.stage_gate_blocked).toBe(1);
    expect(bulkBody.blocked).toEqual([expect.objectContaining({ relationId: relation.id, gate: expect.objectContaining({ code: 'documents' }) })]);
    expect(await stageOf(relation2.id)).toBe('APPROVAL_PENDING_220');
    expect(await stageOf(relation.id)).toBe('APPLICATION_100');

    // 3. Unblocked: once the document exists, the same move passes.
    await prisma.document.create({
      data: { ownerId: mentee.id, uploaderId: mentee.id, requirementId: requirement.id, type: 'OTHER', title: 'Agreement', filename: 'a.pdf', contentType: 'application/pdf', size: 8, data: Buffer.from('%PDF-1.4') },
    });
    const allowed = await page.request.put(`/api/mentorship/${relation.id}`, { data: { pipelineStatus: 'APPROVAL_PENDING_220' } });
    expect(allowed.status()).toBe(200);
    expect(await stageOf(relation.id)).toBe('APPROVAL_PENDING_220');

    // 4. The capability gate: the mentor does not hold pipeline.transition, the admin does.
    const mentorContext = await browser.newContext();
    const mentorPage = await mentorContext.newPage();
    await signInAsFreshUser(mentorPage, mentorEmail, PW, '/mentor');
    const mentorMove = await mentorPage.request.put(`/api/mentorship/${relation.id}`, { data: { pipelineStatus: 'INTERVIEW_PENDING_250' } });
    expect(mentorMove.status()).toBe(409);
    expect((await mentorMove.json()).gate).toMatchObject({ code: 'capability', stage: 'INTERVIEW_PENDING_250' });
    expect(await stageOf(relation.id)).toBe('APPROVAL_PENDING_220');

    // 5. Backwards is never gated — not even into a gated stage's predecessor.
    const back = await mentorPage.request.put(`/api/mentorship/${relation.id}`, { data: { pipelineStatus: 'APPLICATION_100' } });
    expect(back.status()).toBe(200);
    expect(await stageOf(relation.id)).toBe('APPLICATION_100');
    await mentorContext.close();

    // The admin holds the capability (and the document still exists).
    expect((await page.request.put(`/api/mentorship/${relation.id}`, { data: { pipelineStatus: 'APPROVAL_PENDING_220' } })).status()).toBe(200);
    expect((await page.request.put(`/api/mentorship/${relation.id}`, { data: { pipelineStatus: 'INTERVIEW_PENDING_250' } })).status()).toBe(200);
    expect(await stageOf(relation.id)).toBe('INTERVIEW_PENDING_250');

    // 6. An org with nothing configured is unaffected.
    await seedUser(otherAdminEmail, PW, 'ADMIN', 'NoGate Admin', otherOrg.id);
    const otherMentor = await seedUser(otherMentorEmail, PW, 'MENTOR', 'NoGate Mentor', otherOrg.id);
    const otherMentee = await seedUser(otherMenteeEmail, PW, 'MENTEE', 'NoGate Mentee', otherOrg.id);
    const otherRelation = await prisma.mentorshipRelation.create({ data: { orgId: otherOrg.id, mentorId: otherMentor.id, menteeId: otherMentee.id } });
    await page.context().clearCookies();
    await signInAsFreshUser(page, otherAdminEmail, PW, '/admin');
    expect((await page.request.put(`/api/mentorship/${otherRelation.id}`, { data: { pipelineStatus: 'HIRED_660' } })).status()).toBe(200);
    expect(await stageOf(otherRelation.id)).toBe('HIRED_660');
  } finally {
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } }).catch(() => {});
  }
});
