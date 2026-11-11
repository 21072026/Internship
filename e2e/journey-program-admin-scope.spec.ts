import { test, expect, request as playwrightRequest } from '@playwright/test';
import crypto from 'crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The journey builder API (#3582) asks program.read / program.write with the
// programme as its subject: an org admin and a PROGRAM_ADMIN holding a grant
// for the programme get in; a PROGRAM_ADMIN without that grant, and anyone
// reaching another org's programme, get 404 and nothing changes.

const PASSWORD = 'JourneyScope123!';
const STEP = { anchor: 'RELATION_START', offsetDays: 3, audience: 'BOTH', action: 'NUDGE', translations: { en: 'Scoped step' } };

test.afterAll(async () => prisma.$disconnect());

async function ctxFor(email: string) {
  const ctx = await playwrightRequest.newContext({ baseURL: test.info().project.use.baseURL });
  const res = await signInViaApi(ctx, email, PASSWORD);
  expect(res.ok, `sign-in failed for ${email}: ${res.error}`).toBe(true);
  return ctx;
}

test('journey builder: a granted PROGRAM_ADMIN reads and writes its programme; ungranted and cross-tenant are 404', { tag: '@smoke' }, async () => {
  const s = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const orgA = await prisma.organization.create({ data: { name: `Journey A ${s}`, slug: `jscope-a-${s}`, plan: 'ENTERPRISE' } });
  const orgB = await prisma.organization.create({ data: { name: `Journey B ${s}`, slug: `jscope-b-${s}`, plan: 'ENTERPRISE' } });
  const emails = ['js-a-admin', 'js-a-prog', 'js-a-mentor', 'js-a-mentee'].map((p) => uniqueEmail(p).toLowerCase());
  const [adminEmail, progEmail, mentorEmail, menteeEmail] = emails;
  try {
    const admin = await seedUser(adminEmail, PASSWORD, 'ADMIN', 'Journey Org Admin', orgA.id);
    await prisma.user.update({ where: { id: admin.id }, data: { adminLevel: 'ORG_ADMIN' } });
    const prog = await seedUser(progEmail, PASSWORD, 'ADMIN', 'Journey Program Admin', orgA.id);
    await prisma.user.update({ where: { id: prog.id }, data: { adminLevel: 'PROGRAM_ADMIN' } });
    const mentor = await seedUser(mentorEmail, PASSWORD, 'MENTOR', 'Journey Mentor', orgA.id);
    const mentee = await seedUser(menteeEmail, PASSWORD, 'MENTEE', 'Journey Mentee', orgA.id);

    const granted = await prisma.cohort.create({ data: { orgId: orgA.id, name: `Granted ${s}` } });
    const ungranted = await prisma.cohort.create({ data: { orgId: orgA.id, name: `Ungranted ${s}` } });
    const foreign = await prisma.cohort.create({ data: { orgId: orgB.id, name: `Foreign ${s}` } });
    const rel = await prisma.mentorshipRelation.create({ data: { orgId: orgA.id, mentorId: mentor.id, menteeId: mentee.id, cohortId: granted.id } });
    const ungrantedStep = await prisma.programStep.create({ data: { orgId: orgA.id, programId: ungranted.id, action: 'NUDGE', title: 'Untouched' } });
    await prisma.adminScopeGrant.create({ data: { userId: prog.id, orgId: orgA.id, cohortId: granted.id, createdById: admin.id } });

    // --- the granted PROGRAM_ADMIN: every verb works on its programme ---
    const p = await ctxFor(progEmail);
    const read = await p.get(`/api/admin/programs/${granted.id}/journey`);
    expect(read.status()).toBe(200);
    expect((await read.json()).relations.map((r: { id: string }) => r.id)).toContain(rel.id);
    const created = await p.post(`/api/admin/programs/${granted.id}/journey`, { data: STEP });
    expect(created.status()).toBe(201);
    const stepId: string = (await created.json()).step.id;
    expect((await p.patch(`/api/admin/programs/${granted.id}/journey/${stepId}`, { data: { published: true } })).status()).toBe(200);
    expect((await p.patch(`/api/admin/programs/${granted.id}/journey`, { data: { order: [stepId] } })).status()).toBe(200);
    expect((await p.get(`/api/admin/programs/${granted.id}/journey/preview?relationId=${rel.id}`)).status()).toBe(200);
    expect((await p.delete(`/api/admin/programs/${granted.id}/journey/${stepId}`)).status()).toBe(200);

    // --- outside the grant: 404 for every verb, nothing written ---
    for (const programId of [ungranted.id, foreign.id]) {
      expect((await p.get(`/api/admin/programs/${programId}/journey`)).status(), `GET ${programId}`).toBe(404);
      expect((await p.post(`/api/admin/programs/${programId}/journey`, { data: STEP })).status(), `POST ${programId}`).toBe(404);
      expect((await p.patch(`/api/admin/programs/${programId}/journey`, { data: { publish: 'all' } })).status(), `PATCH ${programId}`).toBe(404);
      expect((await p.get(`/api/admin/programs/${programId}/journey/preview?relationId=${rel.id}`)).status(), `preview ${programId}`).toBe(404);
    }
    expect((await p.patch(`/api/admin/programs/${ungranted.id}/journey/${ungrantedStep.id}`, { data: { published: true } })).status()).toBe(404);
    expect((await p.delete(`/api/admin/programs/${ungranted.id}/journey/${ungrantedStep.id}`)).status()).toBe(404);
    const untouched = await prisma.programStep.findUniqueOrThrow({ where: { id: ungrantedStep.id } });
    expect(untouched.publishedAt).toBeNull();
    expect(untouched.archivedAt).toBeNull();
    expect(await prisma.programStep.count({ where: { programId: { in: [ungranted.id, foreign.id] } } })).toBe(1);
    await p.dispose();

    // --- the org admin: its own programmes, never another org's ---
    const a = await ctxFor(adminEmail);
    expect((await a.get(`/api/admin/programs/${ungranted.id}/journey`)).status()).toBe(200);
    expect((await a.post(`/api/admin/programs/${ungranted.id}/journey`, { data: STEP })).status()).toBe(201);
    expect((await a.get(`/api/admin/programs/${foreign.id}/journey`)).status()).toBe(404);
    expect((await a.post(`/api/admin/programs/${foreign.id}/journey`, { data: STEP })).status()).toBe(404);
    expect(await prisma.programStep.count({ where: { programId: foreign.id } })).toBe(0);
    await a.dispose();
  } finally {
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }).catch(() => {});
    for (const e of emails) await cleanupByEmail(e);
    await prisma.cohort.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }).catch(() => {});
  }
});
