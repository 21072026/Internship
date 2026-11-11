import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The cohort pass over a seeded intake (#1794): one proposal per waiting
// mentee, a mentor never proposed beyond their headroom, a not-accepting
// mentor in no proposal, every unplaced mentee with a reason, the same round
// re-run gives the same proposals, zero relations created; a round that is not
// DRAFT is 409, an intake over the cap is 413, a mentor gets 403.
test('cohort pass: capacity ceiling, determinism, reasons, no relations', async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'PassPass123!';
  const org = await prisma.organization.create({ data: { name: `Pass ${stamp}`, slug: `pass-${stamp}` } });
  const bigOrg = await prisma.organization.create({ data: { name: `Pass big ${stamp}`, slug: `pass-big-${stamp}` } });
  const admin = await playwright.request.newContext({ baseURL });
  const bigAdmin = await playwright.request.newContext({ baseURL });
  const mentorCtx = await playwright.request.newContext({ baseURL });
  try {
    const adminEmail = uniqueEmail('pass-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Pass Admin', org.id);
    const withSkills = async (role: 'MENTOR' | 'MENTEE', name: string, skills: string[], data: Record<string, unknown> = {}) => {
      const u = await seedUser(uniqueEmail(`pass-${role.toLowerCase()}`), pw, role, name, org.id);
      return prisma.user.update({ where: { id: u.id }, data: { skills, ...data } });
    };
    const star = await withSkills('MENTOR', 'Star Mentor', ['React'], { mentorCapacity: 2 });
    const closed = await withSkills('MENTOR', 'Closed Mentor', ['React'], { acceptingMentees: false });
    const full = await withSkills('MENTOR', 'Full Mentor', ['SQL'], { mentorCapacity: 1 });
    const react = await Promise.all([1, 2, 3, 4].map((i) => withSkills('MENTEE', `React Mentee ${i}`, ['React'])));
    const sql = await withSkills('MENTEE', 'SQL Mentee', ['SQL']);
    const busy = await withSkills('MENTEE', 'Busy Mentee', ['SQL']);
    // `full` is at capacity with `busy`, who already has an active mentor and
    // so is not in the intake at all.
    await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: full.id, menteeId: busy.id, status: 'ACTIVE' } });
    const intake = [...react.map((m) => m.id), sql.id];

    expect((await signInViaApi(admin, adminEmail, pw)).ok).toBe(true);
    const mentorEmail = (await prisma.user.findUnique({ where: { id: star.id } }))!.email;
    expect((await signInViaApi(mentorCtx, mentorEmail, pw)).ok).toBe(true);

    const round = (await (await admin.post('/api/admin/match-rounds', { data: { name: 'Intake' } })).json()).round as { id: string };
    const relationsBefore = await prisma.mentorshipRelation.count({ where: { orgId: org.id } });

    const run = await admin.post(`/api/admin/match-rounds/${round.id}/run`);
    expect(run.status(), await run.text()).toBe(200);
    const body = await run.json();
    expect(body.stats).toMatchObject({ mentees: 5, proposed: 2, unmatched: { all_at_capacity: 2, below_threshold: 1 }, mentorsUsed: 1 });
    expect(typeof body.stats.durationMs).toBe('number');

    const proposals = () =>
      prisma.matchProposal.findMany({
        where: { roundId: round.id },
        orderBy: { menteeId: 'asc' },
        select: { menteeId: true, mentorId: true, score: true, rank: true, breakdown: true, blockedBy: true, alternatives: true, unmatchedReason: true },
      });
    const first = await proposals();
    // One row per waiting mentee — the one with an active mentor is not proposed one.
    expect(first.map((p) => p.menteeId).sort()).toEqual([...intake].sort());
    // The capacity ceiling holds within the round.
    expect(first.filter((p) => p.mentorId === star.id)).toHaveLength(2);
    expect(first.filter((p) => p.mentorId !== null).every((p) => p.mentorId === star.id)).toBe(true);
    // Not accepting: in no proposal and no alternative.
    expect(JSON.stringify(first)).not.toContain(closed.id);
    // Every unplaced mentee carries a reason.
    expect(first.filter((p) => p.mentorId === null).every((p) => !!p.unmatchedReason)).toBe(true);
    expect(first.find((p) => p.menteeId === sql.id)).toMatchObject({ mentorId: null, unmatchedReason: 'below_threshold' });

    // Same round, same data → the same proposals.
    expect((await admin.post(`/api/admin/match-rounds/${round.id}/run`, { data: {} })).status()).toBe(200);
    expect(JSON.stringify(await proposals())).toBe(JSON.stringify(first));

    // Zero relations created by the pass.
    expect(await prisma.mentorshipRelation.count({ where: { orgId: org.id } })).toBe(relationsBefore);

    // A malformed body is a 400; a mentor is a 403; a round in review is a 409.
    expect((await admin.post(`/api/admin/match-rounds/${round.id}/run`, { data: { minScore: 900 } })).status()).toBe(400);
    expect((await mentorCtx.post(`/api/admin/match-rounds/${round.id}/run`)).status()).toBe(403);
    expect((await admin.patch(`/api/admin/match-rounds/${round.id}`, { data: { status: 'REVIEW' } })).status()).toBe(200);
    expect((await admin.post(`/api/admin/match-rounds/${round.id}/run`)).status()).toBe(409);

    // Over the cap: 413, nothing written.
    const bigAdminEmail = uniqueEmail('pass-big-admin');
    await seedUser(bigAdminEmail, pw, 'ADMIN', 'Big Admin', bigOrg.id);
    await prisma.user.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({ email: `pass-big-${stamp}-${i}@example.test`, fullName: `Big ${i}`, password: 'x', role: 'MENTEE' as const, orgId: bigOrg.id, skills: [] })),
    });
    expect((await signInViaApi(bigAdmin, bigAdminEmail, pw)).ok).toBe(true);
    const bigRound = (await (await bigAdmin.post('/api/admin/match-rounds', { data: { name: 'Big' } })).json()).round as { id: string };
    const tooBig = await bigAdmin.post(`/api/admin/match-rounds/${bigRound.id}/run`);
    expect(tooBig.status()).toBe(413);
    expect(await tooBig.json()).toMatchObject({ code: 'round_too_large', maxMentees: 500 });
    expect(await prisma.matchProposal.count({ where: { roundId: bigRound.id } })).toBe(0);
  } finally {
    await admin.dispose();
    await bigAdmin.dispose();
    await mentorCtx.dispose();
    const orgIds = [org.id, bigOrg.id];
    await prisma.matchRound.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { orgId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  }
});
