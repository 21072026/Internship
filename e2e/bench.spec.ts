import { test, expect, request as playwrightRequest } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';
import { loadMentorPool } from '../src/lib/matching/pool';

// The bench (#1778), in its own org: an admin benches a mentor; the mentor can
// still sign in; isActive, sessionsValidFrom and consentAt are untouched; the
// mentor leaves the matching pool and is refused SERVER-SIDE by every
// assignment path (direct assignment, request approval, their own accept,
// adding a mentee themselves); the BENCHED filter lists them; a cohort is
// benched in one call; returning to active makes them assignable again.

test.afterAll(async () => prisma.$disconnect());

const PW = 'BenchPass123!';

test('bench a mentor: still signs in, not assignable anywhere, back again on return', async ({ baseURL }) => {
  test.setTimeout(120_000);
  const s = `${Date.now()}-${randomBytes(3).toString('hex')}`;
  const org = await prisma.organization.create({ data: { name: `Bench ${s}`, slug: `bench-${s}` } });
  const emails = ['b-admin', 'b-mentor', 'b-mentee', 'b-mentee2', 'b-mentee3'].map((p) => uniqueEmail(p));
  const [adminEmail, mentorEmail, menteeEmail, mentee2Email, mentee3Email] = emails;
  let cohortId = '';
  try {
    await seedUser(adminEmail, PW, 'ADMIN', 'Bench Admin', org.id);
    const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'Bench Mentor', org.id);
    const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'Bench Mentee', org.id);
    const mentee2 = await seedUser(mentee2Email, PW, 'MENTEE', 'Cohort Mentee', org.id);
    const mentee3 = await seedUser(mentee3Email, PW, 'MENTEE', 'Cohort Mentee Two', org.id);
    const consentAt = new Date('2026-01-02T03:04:05Z');
    await prisma.user.update({ where: { id: mentor.id }, data: { consentAt } });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: mentor.id }, select: { sessionsValidFrom: true } });

    const admin = await playwrightRequest.newContext({ baseURL });
    expect((await signInViaApi(admin, adminEmail, PW)).ok).toBe(true);
    const benched = await admin.patch(`/api/admin/users/${mentor.id}/bench`, { data: { benched: true, reason: 'Parental leave' } });
    expect(benched.ok()).toBeTruthy();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: mentor.id }, select: { participantState: true, isActive: true, sessionsValidFrom: true, consentAt: true, benchedReason: true } });
    expect(row).toMatchObject({ participantState: 'BENCHED', isActive: true, benchedReason: 'Parental leave' });
    expect(row.sessionsValidFrom?.getTime() ?? null).toBe(before.sessionsValidFrom?.getTime() ?? null);
    expect(row.consentAt?.toISOString()).toBe(consentAt.toISOString());

    // Still signs in and reads their own record.
    const mentorCtx = await playwrightRequest.newContext({ baseURL });
    expect((await signInViaApi(mentorCtx, mentorEmail, PW)).ok).toBe(true);
    expect((await mentorCtx.get('/api/auth/session').then((r) => r.json())).user?.id).toBe(mentor.id);

    // Out of the matching pool.
    const tenant = { orgId: org.id };
    expect((await loadMentorPool(tenant)).map((m) => m.id)).not.toContain(mentor.id);

    // Refused by every assignment path, server-side.
    const direct = await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: mentee.id } });
    expect(direct.status()).toBe(409);
    expect((await direct.json()).code).toBe('mentor_benched');
    const req = await prisma.mentorshipRequest.create({ data: { menteeId: mentee.id, preferredMentorId: mentor.id } });
    const approve = await admin.put('/api/admin/mentorship-requests', { data: { requestId: req.id, action: 'approve', mentorId: mentor.id } });
    expect(approve.status()).toBe(409);
    const accept = await mentorCtx.put('/api/mentor/applications', { data: { requestId: req.id, action: 'accept' } });
    expect(accept.status()).toBe(409);
    const own = await mentorCtx.post('/api/mentor/mentees', { data: { fullName: 'Self Added' } });
    expect(own.status()).toBe(409);
    expect(await prisma.mentorshipRelation.count({ where: { mentorId: mentor.id } })).toBe(0);

    // The BENCHED filter lists them.
    const list = await admin.get('/api/users?view=directory&status=benched&perPage=50');
    expect((await list.json()).users.map((u: { id: string }) => u.id)).toContain(mentor.id);

    // A whole cohort in one call.
    cohortId = (await prisma.cohort.create({ data: { orgId: org.id, name: `Bench cohort ${s}` } })).id;
    const other = await seedUser(uniqueEmail('b-mentor2'), PW, 'MENTOR', 'Other Mentor', org.id);
    emails.push(other.email);
    await prisma.mentorshipRelation.createMany({
      data: [
        { orgId: org.id, mentorId: other.id, menteeId: mentee2.id, cohortId },
        { orgId: org.id, mentorId: other.id, menteeId: mentee3.id, cohortId },
      ],
    });
    const bulk = await admin.post('/api/admin/users/bench', { data: { cohortId, benched: true } });
    expect((await bulk.json()).changed).toBe(2);
    expect(await prisma.user.count({ where: { id: { in: [mentee2.id, mentee3.id] }, participantState: 'BENCHED' } })).toBe(2);
    // The pairings themselves are untouched.
    expect(await prisma.mentorshipRelation.count({ where: { cohortId, status: 'ACTIVE' } })).toBe(2);

    // Back to active: assignable again.
    expect((await admin.patch(`/api/admin/users/${mentor.id}/bench`, { data: { benched: false } })).ok()).toBeTruthy();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mentor.id } })).benchedReason).toBeNull();
    const again = await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: mentee.id } });
    expect(again.status()).toBe(201);

    // Another tenant's admin cannot bench this mentor.
    const otherOrg = await prisma.organization.create({ data: { name: `Bench other ${s}`, slug: `bench-other-${s}` } });
    const foreignEmail = uniqueEmail('b-foreign');
    emails.push(foreignEmail);
    await seedUser(foreignEmail, PW, 'ADMIN', 'Foreign Admin', otherOrg.id);
    const foreign = await playwrightRequest.newContext({ baseURL });
    expect((await signInViaApi(foreign, foreignEmail, PW)).ok).toBe(true);
    expect((await foreign.patch(`/api/admin/users/${mentor.id}/bench`, { data: { benched: true } })).status()).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mentor.id } })).participantState).toBe('ACTIVE');
    await Promise.all([admin.dispose(), mentorCtx.dispose(), foreign.dispose()]);
    await prisma.organization.deleteMany({ where: { id: otherOrg.id } }).catch(() => {});
  } finally {
    await prisma.mentorshipRequest.deleteMany({ where: { mentee: { orgId: org.id } } });
    for (const e of emails) await cleanupByEmail(e);
    if (cohortId) await prisma.cohort.deleteMany({ where: { id: cohortId } });
    await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
  }
});
