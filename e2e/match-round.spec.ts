import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Bulk matching rounds, the staging area (#1793): a round over a cohort holds
// one proposal per mentee (an unmatched one included); discarding it leaves
// nothing behind and creates no relation; a published round is terminal (409
// on every write); a mentor gets 403 from every round route; another tenant's
// cohort is a 404.
test('rounds: create → proposals → discard leaves nothing; published is terminal; admin-only', async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'RoundPass123!';
  const org = await prisma.organization.create({ data: { name: `Round ${stamp}`, slug: `round-${stamp}` } });
  const otherOrg = await prisma.organization.create({ data: { name: `Round B ${stamp}`, slug: `round-b-${stamp}` } });
  const admin = await playwright.request.newContext({ baseURL });
  const mentorCtx = await playwright.request.newContext({ baseURL });
  try {
    const adminEmail = uniqueEmail('round-admin');
    const mentorEmail = uniqueEmail('round-mentor');
    await seedUser(adminEmail, pw, 'ADMIN', 'Round Admin', org.id);
    const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Round Mentor', org.id);
    const m1 = await seedUser(uniqueEmail('round-mentee'), pw, 'MENTEE', 'Round Mentee One', org.id);
    const m2 = await seedUser(uniqueEmail('round-mentee'), pw, 'MENTEE', 'Round Mentee Two', org.id);
    const cohort = await prisma.cohort.create({ data: { orgId: org.id, name: `Intake ${stamp}` } });
    const foreignCohort = await prisma.cohort.create({ data: { orgId: otherOrg.id, name: `Foreign ${stamp}` } });

    expect((await signInViaApi(admin, adminEmail, pw)).ok).toBe(true);
    expect((await signInViaApi(mentorCtx, mentorEmail, pw)).ok).toBe(true);

    // Another tenant's cohort reads as missing.
    expect((await admin.post('/api/admin/match-rounds', { data: { name: 'Foreign', cohortId: foreignCohort.id } })).status()).toBe(404);

    const created = await admin.post('/api/admin/match-rounds', { data: { name: 'Autumn intake', cohortId: cohort.id } });
    expect(created.status(), await created.text()).toBe(201);
    const round = (await created.json()).round as { id: string; status: string; orgId: string };
    expect(round).toMatchObject({ status: 'DRAFT', orgId: org.id });

    // One proposal per mentee — the unmatched one included (the cohort pass,
    // #1794, writes these; here they are written directly).
    await prisma.matchProposal.createMany({
      data: [
        { orgId: org.id, roundId: round.id, menteeId: m1.id, mentorId: mentor.id, score: 80, rank: 1 },
        { orgId: org.id, roundId: round.id, menteeId: m2.id, mentorId: null, unmatchedReason: 'no_eligible_mentor' },
      ],
    });
    await expect(prisma.matchProposal.create({ data: { orgId: org.id, roundId: round.id, menteeId: m1.id } })).rejects.toThrow();
    const read = await (await admin.get(`/api/admin/match-rounds/${round.id}`)).json();
    expect(read.round.proposals).toHaveLength(2);
    expect(read.round.proposals.find((p: { menteeId: string }) => p.menteeId === m2.id)).toMatchObject({ mentorId: null, unmatchedReason: 'no_eligible_mentor' });

    // DRAFT → REVIEW → DRAFT; publishing is not a status edit.
    expect((await admin.patch(`/api/admin/match-rounds/${round.id}`, { data: { status: 'REVIEW' } })).status()).toBe(200);
    expect((await admin.patch(`/api/admin/match-rounds/${round.id}`, { data: { status: 'PUBLISHED' } })).status()).toBe(400);

    // Discard: proposals gone, no relation created by the round.
    const relationsBefore = await prisma.mentorshipRelation.count({ where: { menteeId: { in: [m1.id, m2.id] } } });
    expect((await admin.delete(`/api/admin/match-rounds/${round.id}`)).status()).toBe(200);
    expect(await prisma.matchProposal.count({ where: { roundId: round.id } })).toBe(0);
    expect((await prisma.matchRound.findUnique({ where: { id: round.id } }))?.status).toBe('DISCARDED');
    expect(await prisma.mentorshipRelation.count({ where: { menteeId: { in: [m1.id, m2.id] } } })).toBe(relationsBefore);
    expect((await admin.delete(`/api/admin/match-rounds/${round.id}`)).status()).toBe(409);

    // A published round is terminal.
    const published = await prisma.matchRound.create({ data: { orgId: org.id, name: 'Done', status: 'PUBLISHED', createdById: mentor.id } });
    expect((await admin.patch(`/api/admin/match-rounds/${published.id}`, { data: { name: 'Renamed' } })).status()).toBe(409);
    expect((await admin.patch(`/api/admin/match-rounds/${published.id}`, { data: { status: 'DRAFT' } })).status()).toBe(409);
    expect((await admin.delete(`/api/admin/match-rounds/${published.id}`)).status()).toBe(409);
    expect((await prisma.matchRound.findUnique({ where: { id: published.id } }))?.name).toBe('Done');

    // A mentor gets 403 from every round route.
    expect((await mentorCtx.get('/api/admin/match-rounds')).status()).toBe(403);
    expect((await mentorCtx.post('/api/admin/match-rounds', { data: { name: 'x' } })).status()).toBe(403);
    expect((await mentorCtx.get(`/api/admin/match-rounds/${published.id}`)).status()).toBe(403);
    expect((await mentorCtx.patch(`/api/admin/match-rounds/${published.id}`, { data: { name: 'x' } })).status()).toBe(403);
    expect((await mentorCtx.delete(`/api/admin/match-rounds/${published.id}`)).status()).toBe(403);
  } finally {
    await admin.dispose();
    await mentorCtx.dispose();
    await prisma.matchRound.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } });
    await prisma.cohort.deleteMany({ where: { orgId: { in: [org.id, otherOrg.id] } } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, otherOrg.id] } } });
  }
});
