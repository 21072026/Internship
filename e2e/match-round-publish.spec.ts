import { test, expect } from '@playwright/test';
import { prisma, seedUser, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// The round board's API (#1796): run a round, swap one row (the score is the
// server's, a browser score is refused), lock two, bulk discard/restore, read
// why the rest are unmatched, and publish — exactly one relation per locked
// proposal, inside one transaction: a plan cap or a mentee paired elsewhere
// meanwhile rolls the WHOLE publish back. Each published pair writes a
// BULK_ROUND MatchDecision and notifies both sides, like a direct assignment.
test('round board: swap, lock, publish exactly the locked pairs, all or nothing', { tag: '@smoke' }, async ({ playwright, baseURL }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pw = 'BoardPass123!';
  const org = await prisma.organization.create({ data: { name: `Board ${stamp}`, slug: `board-${stamp}`, plan: 'FREE' } });
  const admin = await playwright.request.newContext({ baseURL });
  const mentorCtx = await playwright.request.newContext({ baseURL });
  try {
    const adminEmail = uniqueEmail('board-admin');
    await seedUser(adminEmail, pw, 'ADMIN', 'Board Admin', org.id);
    const person = async (role: 'MENTOR' | 'MENTEE', name: string, skills: string[], data: Record<string, unknown> = {}) => {
      const u = await seedUser(uniqueEmail(`board-${role.toLowerCase()}`), pw, role, name, org.id);
      return prisma.user.update({ where: { id: u.id }, data: { skills, ...data } });
    };
    const react = await person('MENTOR', 'React Mentor', ['React'], { mentorCapacity: 5 });
    const sql = await person('MENTOR', 'SQL Mentor', ['SQL'], { mentorCapacity: 5 });
    const closed = await person('MENTOR', 'Closed Mentor', ['React'], { acceptingMentees: false });
    const [m1, m2, m3] = await Promise.all([1, 2, 3].map((i) => person('MENTEE', `React Mentee ${i}`, ['React'])));
    const m4 = await person('MENTEE', 'SQL Mentee', ['SQL']);
    const m5 = await person('MENTEE', 'Cobol Mentee', ['Cobol']);
    const cohort = await prisma.cohort.create({ data: { orgId: org.id, name: `Board intake ${stamp}` } });

    expect((await signInViaApi(admin, adminEmail, pw)).ok).toBe(true);
    expect((await signInViaApi(mentorCtx, react.email, pw)).ok).toBe(true);

    const round = (await (await admin.post('/api/admin/match-rounds', { data: { name: 'Board', cohortId: cohort.id } })).json()).round as { id: string };
    expect((await admin.post(`/api/admin/match-rounds/${round.id}/run`)).status()).toBe(200);
    const rows = async () => {
      const list = await prisma.matchProposal.findMany({ where: { roundId: round.id } });
      return new Map(list.map((p) => [p.menteeId, p]));
    };
    let byMentee = await rows();
    expect(byMentee.get(m1.id)?.mentorId).toBe(react.id);
    expect(byMentee.get(m4.id)?.mentorId).toBe(sql.id);
    expect(byMentee.get(m5.id)).toMatchObject({ mentorId: null, unmatchedReason: 'below_threshold' });
    const url = `/api/admin/match-rounds/${round.id}/proposals`;

    // Swap: a score from the browser is refused outright; the server's is stored.
    const p3 = byMentee.get(m3.id)!;
    expect((await admin.patch(url, { data: { action: 'swap', id: p3.id, mentorId: sql.id, score: 100 } })).status()).toBe(400);
    const swapped = await admin.patch(url, { data: { action: 'swap', id: p3.id, mentorId: sql.id } });
    expect(swapped.status(), await swapped.text()).toBe(200);
    expect((await swapped.json()).proposal).toMatchObject({ mentorId: sql.id, score: 0, rank: null });
    // A mentor who is not accepting is blocked, with the rule named.
    const blocked = await admin.patch(url, { data: { action: 'swap', id: p3.id, mentorId: closed.id } });
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'pair_blocked', blockedBy: ['capacityHeadroom'] });

    // Lock two; the unmatched row cannot be locked and says so.
    const p1 = byMentee.get(m1.id)!;
    const p2 = byMentee.get(m2.id)!;
    const p4 = byMentee.get(m4.id)!;
    const p5 = byMentee.get(m5.id)!;
    const lock = await (await admin.patch(url, { data: { action: 'lock', ids: [p1.id, p2.id, p5.id] } })).json();
    expect(lock).toMatchObject({ changed: 2, skipped: [{ id: p5.id, reason: 'unmatched' }] });
    // Bulk discard and restore.
    expect(await (await admin.patch(url, { data: { action: 'discard', ids: [p4.id, p3.id] } })).json()).toMatchObject({ changed: 2 });
    expect(await (await admin.patch(url, { data: { action: 'restore', ids: [p4.id] } })).json()).toMatchObject({ changed: 1 });
    byMentee = await rows();
    expect(byMentee.get(m1.id)?.state).toBe('LOCKED');
    expect(byMentee.get(m3.id)?.state).toBe('DISCARDED');
    expect(byMentee.get(m4.id)?.state).toBe('DRAFT');

    // Why the rest are unmatched.
    const diag = (await (await admin.get(`/api/admin/match-rounds/${round.id}/diagnostics`)).json()).diagnostics;
    expect(diag).toMatchObject({ unmatchedTotal: 1, byReason: [{ reason: 'below_threshold', count: 1, menteeIds: [m5.id] }] });
    expect(diag.shortages).toContainEqual({ skill: 'Cobol', mentees: 1, mentorsWithHeadroom: 0 });

    // Publishing needs the round in review.
    const publish = `/api/admin/match-rounds/${round.id}/publish`;
    expect(await (await admin.post(publish)).json()).toMatchObject({ code: 'round_not_in_review' });
    expect((await admin.patch(`/api/admin/match-rounds/${round.id}`, { data: { status: 'REVIEW' } })).status()).toBe(200);

    const relationsOf = () => prisma.mentorshipRelation.findMany({ where: { menteeId: { in: [m1.id, m2.id, m3.id, m4.id, m5.id] } } });

    // The plan cap refuses the whole publish, naming the limit (FREE = 25): 24
    // active pairs already, two to add.
    const filler = await person('MENTOR', 'Filler Mentor', []);
    const fillerMentees = await Promise.all(Array.from({ length: 24 }, (_, i) => prisma.user.create({ data: { email: `board-fill-${stamp}-${i}@example.test`, password: 'x', fullName: `Filler ${i}`, role: 'MENTEE', orgId: org.id, skills: [] } })));
    await prisma.mentorshipRelation.createMany({ data: fillerMentees.map((u) => ({ orgId: org.id, mentorId: filler.id, menteeId: u.id, status: 'ACTIVE' as const })) });
    const capped = await admin.post(publish);
    expect(capped.status()).toBe(403);
    expect(await capped.json()).toMatchObject({ code: 'plan_limit_reached', limit: 25, needed: 2 });
    expect(await relationsOf()).toHaveLength(0);
    await prisma.mentorshipRelation.deleteMany({ where: { mentorId: filler.id } });

    // A mentee paired elsewhere meanwhile rolls everything back — m1's
    // relation, created first in the transaction, does not survive.
    const elsewhere = await prisma.mentorshipRelation.create({ data: { orgId: org.id, mentorId: sql.id, menteeId: m2.id, status: 'ACTIVE' } });
    const conflict = await admin.post(publish);
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'already_mentored', menteeId: m2.id });
    expect((await relationsOf()).map((r) => r.id)).toEqual([elsewhere.id]);
    expect((await prisma.matchRound.findUnique({ where: { id: round.id } }))?.status).toBe('REVIEW');
    expect((await rows()).get(m1.id)?.state).toBe('LOCKED');
    await prisma.mentorshipRelation.delete({ where: { id: elsewhere.id } });

    // Publish: exactly the two locked pairs, nothing for draft or discarded rows.
    const done = await admin.post(publish);
    expect(done.status(), await done.text()).toBe(200);
    expect(await done.json()).toMatchObject({ published: 2 });
    const relations = await relationsOf();
    expect(relations).toHaveLength(2);
    expect(relations.map((r) => [r.menteeId, r.mentorId, r.cohortId, r.status]).sort()).toEqual(
      [[m1.id, react.id, cohort.id, 'ACTIVE'], [m2.id, react.id, cohort.id, 'ACTIVE']].sort(),
    );
    byMentee = await rows();
    expect(byMentee.get(m1.id)).toMatchObject({ state: 'PUBLISHED', relationId: relations.find((r) => r.menteeId === m1.id)!.id });
    expect(byMentee.get(m4.id)?.state).toBe('DRAFT');
    expect(await prisma.matchRound.findUnique({ where: { id: round.id } })).toMatchObject({ status: 'PUBLISHED' });

    // Same aftermath as a direct assignment: a BULK_ROUND decision with the
    // proposal's own score, and both sides notified.
    const decisions = await prisma.matchDecision.findMany({ where: { roundId: round.id } });
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.source === 'BULK_ROUND' && d.score === p1.score)).toBe(true);
    await expect.poll(() => prisma.notification.count({ where: { userId: { in: [m1.id, m2.id] } } })).toBeGreaterThanOrEqual(2);
    expect(await prisma.notification.count({ where: { userId: react.id } })).toBeGreaterThanOrEqual(2);

    // Published is terminal; a mentor reaches none of it.
    expect((await admin.post(publish)).status()).toBe(409);
    expect((await admin.patch(url, { data: { action: 'unlock', ids: [p1.id] } })).status()).toBe(409);
    expect((await mentorCtx.post(publish)).status()).toBe(403);
    expect((await mentorCtx.patch(url, { data: { action: 'lock', ids: [p4.id] } })).status()).toBe(403);
    expect((await mentorCtx.get(`/api/admin/match-rounds/${round.id}/diagnostics`)).status()).toBe(403);
  } finally {
    await admin.dispose();
    await mentorCtx.dispose();
    await prisma.matchDecision.deleteMany({ where: { orgId: org.id } });
    await prisma.matchRound.deleteMany({ where: { orgId: org.id } });
    await prisma.mentorshipRelation.deleteMany({ where: { orgId: org.id } });
    await prisma.notification.deleteMany({ where: { user: { orgId: org.id } } });
    await prisma.cohort.deleteMany({ where: { orgId: org.id } });
    await prisma.user.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
