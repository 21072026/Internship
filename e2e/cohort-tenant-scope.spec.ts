import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// A programme (cohort) is written only inside its own tenant and, for a
// PROGRAM_ADMIN, only inside a grant. Every write route under /api/cohorts/[id]
// answers 404 for a programme the caller may not touch — another org's, or one
// a PROGRAM_ADMIN holds no grant for — and changes nothing.

const PASSWORD = 'CohortScope123!';

test.afterAll(async () => prisma.$disconnect());

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

test('cohort writes stay in the tenant and the grant: cross-tenant and ungranted PATCH/DELETE/clone are 404', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `Scope A ${s}`, slug: `cscope-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `Scope B ${s}`, slug: `cscope-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['cs-a-admin', 'cs-a-prog', 'cs-b-admin', 'cs-b-mentor', 'cs-b-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [aAdminEmail, aProgEmail, bAdminEmail, bMentorEmail, bMenteeEmail] = emails;
  try {
    const aAdmin = await seedUser(aAdminEmail, PASSWORD, 'ADMIN', 'Scope A Admin', orgA.id);
    await prisma.user.update({ where: { id: aAdmin.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const aProg = await seedUser(aProgEmail, PASSWORD, 'ADMIN', 'Scope A Program Admin', orgA.id);
    await prisma.user.update({ where: { id: aProg.id }, data: { adminLevel: 'PROGRAM_ADMIN' } });
    await seedUser(bAdminEmail, PASSWORD, 'ADMIN', 'Scope B Admin', orgB.id);
    const bMentor = await seedUser(bMentorEmail, PASSWORD, 'MENTOR', 'Scope B Mentor', orgB.id);
    const bMentee = await seedUser(bMenteeEmail, PASSWORD, 'MENTEE', 'Scope B Mentee', orgB.id);

    const granted = await prisma.cohort.create({ data: { orgId: orgA.id, name: `Granted ${s}` } });
    const ungranted = await prisma.cohort.create({ data: { orgId: orgA.id, name: `Ungranted ${s}` } });
    const foreign = await prisma.cohort.create({ data: { orgId: orgB.id, name: `Foreign ${s}` } });
    const foreignRel = await prisma.mentorshipRelation.create({ data: { orgId: orgB.id, mentorId: bMentor.id, menteeId: bMentee.id, cohortId: foreign.id } });
    await prisma.adminScopeGrant.create({ data: { userId: aProg.id, orgId: orgA.id, cohortId: granted.id, createdById: aAdmin.id } });

    // --- another tenant's programme: 404 for every verb, nothing changes ---
    const admin = await ctxFor(aAdminEmail);
    expect((await admin.patch(`/api/cohorts/${foreign.id}`, { data: { name: 'Renamed across tenants' } })).status()).toBe(404);
    expect((await admin.delete(`/api/cohorts/${foreign.id}`)).status()).toBe(404);
    expect((await admin.post(`/api/cohorts/${foreign.id}/clone`, { data: { name: 'Cloned across tenants' } })).status()).toBe(404);
    expect((await prisma.cohort.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(`Foreign ${s}`);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: foreignRel.id } })).cohortId).toBe(foreign.id);

    // --- the org admin's own programme: allowed ---
    const renamed = await admin.patch(`/api/cohorts/${ungranted.id}`, { data: { name: `Ungranted renamed ${s}` } });
    expect(renamed.status()).toBe(200);
    expect((await renamed.json()).cohort.name).toBe(`Ungranted renamed ${s}`);

    // --- a PROGRAM_ADMIN: its grant only; anything else reads as missing ---
    const prog = await ctxFor(aProgEmail);
    expect((await prog.patch(`/api/cohorts/${ungranted.id}`, { data: { name: 'Not mine' } })).status()).toBe(404);
    expect((await prog.delete(`/api/cohorts/${ungranted.id}`)).status()).toBe(404);
    expect((await prog.post(`/api/cohorts/${ungranted.id}/clone`, { data: { name: 'Not mine' } })).status()).toBe(404);
    expect((await prog.patch(`/api/cohorts/${foreign.id}`, { data: { name: 'Not mine' } })).status()).toBe(404);
    expect((await prog.delete(`/api/cohorts/${foreign.id}`)).status()).toBe(404);
    expect(await prisma.cohort.count({ where: { id: { in: [ungranted.id, foreign.id] } } })).toBe(2);
    expect((await prisma.cohort.findUniqueOrThrow({ where: { id: ungranted.id } })).name).toBe(`Ungranted renamed ${s}`);
    expect((await prog.patch(`/api/cohorts/${granted.id}`, { data: { term: '2027 Spring' } })).status()).toBe(200);
    expect((await prisma.cohort.findUniqueOrThrow({ where: { id: granted.id } })).term).toBe('2027 Spring');

    // --- the org admin deletes its own programme ---
    expect((await admin.delete(`/api/cohorts/${ungranted.id}`)).status()).toBe(200);
    expect(await prisma.cohort.count({ where: { id: ungranted.id } })).toBe(0);
    await admin.dispose();
    await prog.dispose();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }).catch(() => {});
  }
});
