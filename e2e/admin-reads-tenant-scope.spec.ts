import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Four smaller admin surfaces that relied on the tenant middleware (#3588),
// which is off in every deployment (and in this project): the team to-do list,
// a company's entitlement map, mentor-suggestion feedback and an AI artefact.
// An admin of org A must see none of org B's rows and get a 404 — never a 403
// that would confirm the id — for B's.

const PASSWORD = 'AdminReadScope123!';

test.afterAll(async () => prisma.$disconnect());

test('admin reads: team to-dos, entitlements, suggestion feedback and AI artefacts stay in the org', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `AR A ${s}`, slug: `ar-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `AR B ${s}`, slug: `ar-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['ar-a-admin', 'ar-a-mentor', 'ar-b-mentor', 'ar-b-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdmin, aMentor, bMentor, bMentee] = emails;
  const batchId = `ar-batch-${s}`;
  try {
    const adminA = await seedUser(aAdmin, PASSWORD, 'ADMIN', 'AR A Admin', orgA.id);
    await prisma.user.update({ where: { id: adminA.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const am = await seedUser(aMentor, PASSWORD, 'MENTOR', 'AR A Mentor', orgA.id);
    const bm = await seedUser(bMentor, PASSWORD, 'MENTOR', 'AR B Mentor', orgB.id);
    const be = await seedUser(bMentee, PASSWORD, 'MENTEE', 'AR B Mentee', orgB.id);
    const aCompany = await prisma.company.create({ data: { orgId: orgA.id, name: `AR A Company ${s}` } });
    const bCompany = await prisma.company.create({ data: { orgId: orgB.id, name: `AR B Company ${s}` } });
    const aTask = await prisma.projectTask.create({ data: { title: `Own task ${s}`, assigneeId: am.id, createdById: adminA.id } });
    const bTask = await prisma.projectTask.create({ data: { title: `Foreign task ${s}`, assigneeId: bm.id, createdById: be.id } });
    await prisma.matchFeedback.create({ data: { orgId: orgB.id, batchId, menteeId: be.id, mentorId: bm.id, rank: 1 } });
    const bArtifact = await prisma.aiArtifact.create({
      data: { orgId: orgB.id, taskId: 'cv_summary', createdById: bm.id, subjectUserId: be.id, inputHash: 'x'.repeat(64), content: `Foreign artefact ${s}` },
    });

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, aAdmin, PASSWORD);
    expect(signed.ok, `sign-in failed: ${signed.error}`).toBe(true);

    // Team to-dos: A's mentor's task (negative control), never B's.
    const team = await ctx.get('/api/todos?scope=team');
    expect(team.status()).toBe(200);
    const teamText = await team.text();
    expect(teamText).toContain(aTask.id);
    expect(teamText).not.toContain(bTask.id);

    // A company's entitlement map: own 200, another org's 404.
    expect((await ctx.get(`/api/admin/companies/${aCompany.id}/entitlements`)).status()).toBe(200);
    expect((await ctx.get(`/api/admin/companies/${bCompany.id}/entitlements`)).status()).toBe(404);

    // Suggestion feedback on another org's batch: missing, and the row is untouched.
    expect((await ctx.post('/api/admin/mentor-suggest/feedback', { data: { batchId, mentorId: bm.id, action: 'ACCEPTED' } })).status()).toBe(404);
    expect((await prisma.matchFeedback.findFirstOrThrow({ where: { batchId } })).action).toBe('SHOWN');
    expect(await prisma.matchFeedback.count({ where: { batchId } })).toBe(1);

    // Another org's AI artefact: 404, not the 403 that confirms it exists.
    const art = await ctx.get(`/api/ai/artifacts/${bArtifact.id}`);
    expect(art.status()).toBe(404);
    expect(await art.text()).not.toContain('Foreign artefact');
    await ctx.dispose();
  } finally {
    await prisma.aiArtifact.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.matchFeedback.deleteMany({ where: { batchId } });
    await prisma.projectTask.deleteMany({ where: { title: { endsWith: s } } });
    await prisma.company.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
