import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The programme on a pairing (#1626): an input when the pairing is created and
// a filter when pairings are listed. The filter is ANDed with the caller's own
// scope, so it only ever narrows; another org's programme is a 404 and is never
// written; a PROGRAM_ADMIN creates pairings only in a granted programme and
// never sees the "unassigned" bucket; a re-match stays in its programme; the
// one-active-mentor rule is untouched. Another org's programme id on the
// list is a 404, the analytics filter's rule (#1652).

const PASSWORD = 'RelProgram123!';

test.afterAll(async () => prisma.$disconnect());

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

type Ctx = Awaited<ReturnType<typeof ctxFor>>;
const programList = (ctx: Ctx, program: string) => ctx.get(`/api/mentorship?program=${encodeURIComponent(program)}&pageSize=100`);
const listed = async (ctx: Ctx, program: string) => {
  const res = await programList(ctx, program);
  expect(res.status()).toBe(200);
  return ((await res.json()).relations as { id: string }[]).map((r) => r.id).sort();
};

test('a pairing carries its programme: created into one, filtered by it, scoped by grant, kept on re-match', { tag: '@smoke' }, async () => {
  test.setTimeout(120_000);
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `RelProg A ${s}`, slug: `relprog-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `RelProg B ${s}`, slug: `relprog-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['rp-admin', 'rp-prog', 'rp-mentor', 'rp-mentor2', 'rp-m1', 'rp-m2', 'rp-m3', 'rp-m4', 'rp-m5'].map((p) => uniqueEmail(p).toLowerCase());
  const [adminEmail, progEmail, mentorEmail, mentor2Email, m1Email, m2Email, m3Email, m4Email, m5Email] = emails;
  try {
    const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'RelProg Org Admin', orgA.id);
    await prisma.user.update({ where: { id: admin.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const prog = await seedUser(progEmail, PASSWORD, 'ADMIN', 'RelProg Program Admin', orgA.id);
    await prisma.user.update({ where: { id: prog.id }, data: { adminLevel: 'PROGRAM_ADMIN' } });
    const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'RelProg Mentor', orgA.id);
    const mentor2 = await seedUser(mentor2Email, PASSWORD, 'MENTOR', 'RelProg Mentor Two', orgA.id);
    const [m1, m2, m3, m4, m5] = await Promise.all(
      [m1Email, m2Email, m3Email, m4Email, m5Email].map((e, i) => seedUser(e, PASSWORD, 'MENTEE', `RelProg Mentee ${i + 1}`, orgA.id)),
    );
    const p1 = await prisma.cohort.create({ data: { orgId: orgA.id, name: `Programme One ${s}` } });
    const p2 = await prisma.cohort.create({ data: { orgId: orgA.id, name: `Programme Two ${s}` } });
    const foreign = await prisma.cohort.create({ data: { orgId: orgB.id, name: `Foreign ${s}` } });
    await prisma.adminScopeGrant.create({ data: { userId: prog.id, orgId: orgA.id, cohortId: p1.id, createdById: admin.id } });

    // --- the org admin creates pairings into two programmes and into none ---
    const a = await ctxFor(adminEmail);
    const create = (ctx: Ctx, menteeId: string, cohortId?: string) =>
      ctx.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId, ...(cohortId ? { cohortId } : {}) } });
    const r1 = await create(a, m1.id, p1.id);
    expect(r1.status()).toBe(201);
    const rel1 = (await r1.json()).relation;
    expect(rel1.cohortId).toBe(p1.id);
    const r2 = await create(a, m2.id, p2.id);
    expect(r2.status()).toBe(201);
    const rel2 = (await r2.json()).relation;
    const r3 = await create(a, m3.id);
    expect(r3.status()).toBe(201);
    const rel3 = (await r3.json()).relation;
    expect(rel3.cohortId).toBeNull();

    // Another org's programme: 404, and no pairing is written for that mentee.
    const cross = await create(a, m4.id, foreign.id);
    expect(cross.status()).toBe(404);
    expect((await cross.json()).code).toBe('program_not_found');
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: m4.id } })).toBe(0);

    // One active mentor per mentee is untouched by the programme (#419).
    expect((await create(a, m1.id, p2.id)).status()).toBe(409);

    // The filter separates them; "unassigned" is the bucket of the cohort-less one.
    expect(await listed(a, p1.id)).toEqual([rel1.id]);
    expect(await listed(a, p2.id)).toEqual([rel2.id]);
    expect(await listed(a, 'unassigned')).toEqual([rel3.id]);
    // Another org's programme id is refused before anything is read.
    expect((await programList(a, foreign.id)).status()).toBe(404);

    // --- a PROGRAM_ADMIN: only its granted programme, no unassigned bucket ---
    const p = await ctxFor(progEmail);
    expect(await listed(p, p1.id)).toEqual([rel1.id]);
    expect(await listed(p, p2.id)).toEqual([]);
    expect(await listed(p, 'unassigned')).toEqual([]);
    expect((await programList(p, foreign.id)).status()).toBe(404);
    const ungranted = await create(p, m4.id, p2.id);
    expect(ungranted.status()).toBe(404);
    expect((await create(p, m4.id, foreign.id)).status()).toBe(404);
    expect((await create(p, m4.id)).status()).toBe(403);
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: m4.id } })).toBe(0);
    const granted = await create(p, m4.id, p1.id);
    expect(granted.status()).toBe(201);
    expect((await granted.json()).relation.cohortId).toBe(p1.id);
    await p.dispose();

    // --- a re-match keeps the programme ---
    const menteeCtx = await ctxFor(m5Email);
    const r5 = await create(a, m5.id, p2.id);
    expect(r5.status()).toBe(201);
    const rel5 = (await r5.json()).relation;
    const asked = await menteeCtx.post(`/api/mentorship/${rel5.id}/rematch`, { data: { reason: 'no_fit' } });
    expect(asked.status()).toBe(201);
    const request = await prisma.mentorshipRequest.findFirstOrThrow({ where: { replacesRelationId: rel5.id } });
    expect(request.programId).toBe(p2.id);
    const approved = await a.put('/api/admin/mentorship-requests', { data: { requestId: request.id, action: 'approve', mentorId: mentor2.id } });
    expect(approved.status()).toBe(200);
    const replacement = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: m5.id, status: 'ACTIVE' } });
    expect(replacement.mentorId).toBe(mentor2.id);
    expect(replacement.cohortId).toBe(p2.id);
    await menteeCtx.dispose();
    await a.dispose();
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { mentee: { orgId: orgA.id } } }).catch(() => {});
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }).catch(() => {});
  }
});
