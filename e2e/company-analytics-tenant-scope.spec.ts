import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// GET /api/company/analytics serves COMPANY users (their own company) and
// admins (#3588). The admin branch has no company to narrow by, and the tenant
// middleware is off in every deployment — so the route must write the caller's
// org into its own queries. Here an admin of org A must count A's relations
// only, never org B's, with MT_ENFORCE_ISOLATION off (this project's default).

const PASSWORD = 'AnalyticsScope123!';

test.afterAll(async () => prisma.$disconnect());

test('company analytics: an admin counts its own org only', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `CA A ${s}`, slug: `ca-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `CA B ${s}`, slug: `ca-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['ca-a-admin', 'ca-a-mentor', 'ca-a-mentee', 'ca-b-mentor', 'ca-b-mentee1', 'ca-b-mentee2'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdmin, aMentor, aMentee, bMentor, bMentee1, bMentee2] = emails;
  try {
    const admin = await seedUser(aAdmin, PASSWORD, 'ADMIN', 'CA A Admin', orgA.id);
    await prisma.user.update({ where: { id: admin.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const am = await seedUser(aMentor, PASSWORD, 'MENTOR', 'CA A Mentor', orgA.id);
    const ae = await seedUser(aMentee, PASSWORD, 'MENTEE', 'CA A Mentee', orgA.id);
    const bm = await seedUser(bMentor, PASSWORD, 'MENTOR', 'CA B Mentor', orgB.id);
    const be1 = await seedUser(bMentee1, PASSWORD, 'MENTEE', 'CA B Mentee 1', orgB.id);
    const be2 = await seedUser(bMentee2, PASSWORD, 'MENTEE', 'CA B Mentee 2', orgB.id);
    await prisma.mentorshipRelation.create({ data: { orgId: orgA.id, mentorId: am.id, menteeId: ae.id } });
    await prisma.mentorshipRelation.create({ data: { orgId: orgB.id, mentorId: bm.id, menteeId: be1.id, pipelineStatus: 'HIRED_660' } });
    await prisma.mentorshipRelation.create({ data: { orgId: orgB.id, mentorId: bm.id, menteeId: be2.id, pipelineStatus: 'HIRED_660' } });

    const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
    const signed = await signInViaApi(ctx, aAdmin, PASSWORD);
    expect(signed.ok, signed.error).toBe(true);
    const res = await ctx.get('/api/company/analytics');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Org A has exactly one relation; org B's two HIRED ones must not be counted.
    expect(body.total).toBe(1);
    expect(body.funnel.HIRED_660 ?? 0).toBe(0);
    await ctx.dispose();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
  }
});
