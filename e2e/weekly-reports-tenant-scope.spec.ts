import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Weekly reports stay inside the caller's org (#3588). `canReadWeeklyReports()`
// lets any ADMIN read, and the tenant middleware is off in every deployment (and
// in this project) — so the routes scope their own lookups. An admin of org A
// must not read org B's reports, by relation or by report id.

const PASSWORD = 'WeeklyScope123!';

test.afterAll(async () => prisma.$disconnect());

test('weekly reports: another org\'s relation and report read as missing to an admin', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `WR A ${s}`, slug: `wr-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `WR B ${s}`, slug: `wr-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['wr-a-admin', 'wr-a-mentor', 'wr-a-mentee', 'wr-b-mentor', 'wr-b-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdmin, aMentor, aMentee, bMentor, bMentee] = emails;
  try {
    const adminA = await seedUser(aAdmin, PASSWORD, 'ADMIN', 'WR A Admin', orgA.id);
    await prisma.user.update({ where: { id: adminA.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const am = await seedUser(aMentor, PASSWORD, 'MENTOR', 'WR A Mentor', orgA.id);
    const ae = await seedUser(aMentee, PASSWORD, 'MENTEE', 'WR A Mentee', orgA.id);
    const bm = await seedUser(bMentor, PASSWORD, 'MENTOR', 'WR B Mentor', orgB.id);
    const be = await seedUser(bMentee, PASSWORD, 'MENTEE', 'WR B Mentee', orgB.id);
    const aRel = await prisma.mentorshipRelation.create({ data: { orgId: orgA.id, mentorId: am.id, menteeId: ae.id } });
    const bRel = await prisma.mentorshipRelation.create({ data: { orgId: orgB.id, mentorId: bm.id, menteeId: be.id } });
    const weekStart = new Date(Date.UTC(2026, 0, 5));
    const aReport = await prisma.weeklyReport.create({ data: { orgId: orgA.id, relationId: aRel.id, weekStart, summary: `Own summary ${s}` } });
    const bReport = await prisma.weeklyReport.create({ data: { orgId: orgB.id, relationId: bRel.id, weekStart, summary: `Foreign summary ${s}` } });

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, aAdmin, PASSWORD);
    expect(signed.ok, `sign-in failed: ${signed.error}`).toBe(true);

    // Negative control: the admin's own org opens.
    const own = await ctx.get(`/api/weekly-reports?relationId=${aRel.id}`);
    expect(own.status()).toBe(200);
    expect(await own.text()).toContain(aReport.id);
    expect((await ctx.get(`/api/weekly-reports/${aReport.id}`)).status()).toBe(200);

    // Another org's relation and report: missing, and nothing of them in the body.
    const foreignList = await ctx.get(`/api/weekly-reports?relationId=${bRel.id}`);
    expect(foreignList.status()).toBe(404);
    expect(await foreignList.text()).not.toContain(bReport.id);
    const foreignOne = await ctx.get(`/api/weekly-reports/${bReport.id}`);
    expect(foreignOne.status()).toBe(404);
    expect(await foreignOne.text()).not.toContain('Foreign summary');
    await ctx.dispose();
  } finally {
    await prisma.weeklyReport.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
