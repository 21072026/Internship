import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, cleanupByEmail, uniqueEmail, seedUser } from './helpers/db';
import { signInViaApi } from './helpers/auth';

/**
 * Program-scoped delegated admin (#1577). Two cohorts in one org; a
 * PROGRAM_ADMIN granted cohort A:
 *   • GET /api/mentorship lists cohort A's relation only — not cohort B's, not
 *     the cohort-less one (out of every program scope, deliberately);
 *   • opening or writing a cohort-B relation is a 403, not a silent no-op;
 *   • moving its own relation into cohort B (out of its reach) is refused;
 *   • the candidate and user lists and the /admin dashboard narrow the same
 *     way, and so does the analytics overview; bulk edit (`user.write`, not in
 *     the tier) and the other analytics routes stay a 403;
 *   • with zero grants the list is empty, and an ORG_ADMIN still reads all three.
 * The builders themselves are unit-tested in
 * scripts/test/authz-scope-program-admin.test.mjs.
 */

const PASSWORD = 'ProgScope123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

const listedIds = async (ctx: Awaited<ReturnType<typeof ctxFor>>) => {
  const res = await ctx.get('/api/mentorship');
  expect(res.status()).toBe(200);
  return ((await res.json()).relations as { id: string }[]).map((r) => r.id).sort();
};

test('program admin: reads and writes only its granted cohort; cohort-less relations are out of scope', { tag: '@smoke' }, async () => {
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Prog scope ${stamp}`, slug: `prog-scope-${stamp}` } });
  const emails = ['ps-org', 'ps-prog', 'ps-mentor', 'ps-mentee-a', 'ps-mentee-b', 'ps-mentee-n'].map((p) => uniqueEmail(p).toLowerCase());
  const [orgEmail, progEmail, mentorEmail, aEmail, bEmail, nEmail] = emails;
  const orgAdmin = await seedUser(orgEmail, PASSWORD, 'ADMIN', 'Org Admin', org.id);
  const prog = await seedUser(progEmail, PASSWORD, 'ADMIN', 'Program Admin', org.id);
  await prisma.user.update({ where: { id: orgAdmin.id }, data: { adminLevel: 'ORG_ADMIN' } });
  await prisma.user.update({ where: { id: prog.id }, data: { adminLevel: 'PROGRAM_ADMIN' } });
  const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Scope Mentor', org.id);
  const menteeA = await seedUser(aEmail, PASSWORD, 'MENTEE', `Mentee A ${stamp}`, org.id);
  const menteeB = await seedUser(bEmail, PASSWORD, 'MENTEE', `Mentee B ${stamp}`, org.id);
  const menteeN = await seedUser(nEmail, PASSWORD, 'MENTEE', `Mentee N ${stamp}`, org.id);
  const cohortA = await prisma.cohort.create({ data: { name: `Cohort A ${stamp}`, orgId: org.id } });
  const cohortB = await prisma.cohort.create({ data: { name: `Cohort B ${stamp}`, orgId: org.id } });
  const rel = (menteeId: string, cohortId: string | null) =>
    prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: mentor.id, menteeId, cohortId } });
  const rA = await rel(menteeA.id, cohortA.id);
  const rB = await rel(menteeB.id, cohortB.id);
  const rN = await rel(menteeN.id, null);

  const ctxProg = await ctxFor(progEmail);
  const ctxOrg = await ctxFor(orgEmail);
  try {
    // Zero grants: an empty list, never the tenant.
    expect(await listedIds(ctxProg)).toEqual([]);
    expect((await ctxProg.get(`/api/mentorship/${rA.id}`)).status()).toBe(403);

    await prisma.adminScopeGrant.create({ data: { userId: prog.id, orgId: org.id, cohortId: cohortA.id, createdById: orgAdmin.id } });

    // Reads: cohort A only.
    expect(await listedIds(ctxProg)).toEqual([rA.id]);
    expect((await ctxProg.get(`/api/mentorship/${rA.id}`)).status()).toBe(200);
    expect((await ctxProg.get(`/api/mentorship/${rB.id}`)).status()).toBe(403);
    expect((await ctxProg.get(`/api/mentorship/${rN.id}`)).status()).toBe(403);

    // Writes: in scope succeeds, out of scope is a 403 and changes nothing.
    expect((await ctxProg.put(`/api/mentorship/${rA.id}`, { data: { expectedMeetingIntervalWeeks: 3 } })).status()).toBe(200);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rA.id } })).expectedMeetingIntervalWeeks).toBe(3);
    expect((await ctxProg.put(`/api/mentorship/${rB.id}`, { data: { expectedMeetingIntervalWeeks: 3 } })).status()).toBe(403);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rB.id } })).expectedMeetingIntervalWeeks).toBeNull();

    // Handing its relation to a cohort it does not hold, or stripping the cohort.
    for (const cohortId of [cohortB.id, null]) {
      const moved = await ctxProg.put(`/api/mentorship/${rA.id}`, { data: { cohortId } });
      expect(moved.status()).toBe(403);
      expect((await moved.json()).code).toBe('outside_scope');
    }
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: rA.id } })).cohortId).toBe(cohortA.id);

    // The candidate and people lists: cohort A's mentee (and the mentor of a
    // relation inside the grant) only.
    const cands = await ctxProg.get('/api/candidates?all=1');
    expect(cands.status()).toBe(200);
    expect(((await cands.json()).candidates as { id: string }[]).map((c) => c.id)).toEqual([menteeA.id]);
    const users = await ctxProg.get('/api/users');
    expect(users.status()).toBe(200);
    expect(((await users.json()).users as { id: string }[]).map((u) => u.id).sort()).toEqual([mentor.id, menteeA.id].sort());

    // Bulk edit asks `user.write`, which the PROGRAM_ADMIN tier does not hold
    // (authzRule.ts) — refused for every id, its own cohort's included.
    const bulk = await ctxProg.post('/api/admin/candidates/bulk', { data: { candidateIds: [menteeA.id], action: 'deactivate' } });
    expect(bulk.status()).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: menteeA.id } })).isActive).toBe(true);

    // The server-rendered dashboard lists its own programme's people only.
    const dash = await (await ctxProg.get('/admin')).text();
    expect(dash).toContain(`Mentee A ${stamp}`);
    expect(dash).not.toContain(`Mentee B ${stamp}`);
    expect(dash).not.toContain(`Mentee N ${stamp}`);

    // The analytics overview counts its programme only — relations, signups,
    // the programme picker — and the routes not narrowed yet stay a 403.
    const progStats = await ctxProg.get('/api/admin/analytics');
    expect(progStats.status()).toBe(200);
    const ps = await progStats.json();
    expect(ps.totalRelations).toBe(1);
    expect(ps.programs.map((p: { id: string }) => p.id)).toEqual([cohortA.id]);
    expect(ps.signupFunnel[0].registered).toBe(2); // mentee A and the mentor, nobody else of the org
    const orgStats = await (await ctxOrg.get('/api/admin/analytics')).json();
    expect(orgStats.totalRelations).toBe(3);
    expect(orgStats.programs.map((p: { id: string }) => p.id).sort()).toEqual([cohortA.id, cohortB.id].sort());
    expect((await ctxProg.get('/api/admin/analytics/funnel')).status()).toBe(403);
    expect((await ctxProg.get('/api/admin/analytics/narrative')).status()).toBe(403);

    // The org admin is unaffected.
    expect(await listedIds(ctxOrg)).toEqual([rA.id, rB.id, rN.id].sort());
    const orgCands = ((await (await ctxOrg.get('/api/candidates?all=1')).json()).candidates as { id: string }[]).map((c) => c.id);
    expect(orgCands.sort()).toEqual([menteeA.id, menteeB.id, menteeN.id].sort());
  } finally {
    await ctxProg.dispose();
    await ctxOrg.dispose();
    await prisma.adminScopeGrant.deleteMany({ where: { orgId: org.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    for (const e of emails) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { orgId: org.id } });
    await prisma.auditLog.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.activityLog.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
