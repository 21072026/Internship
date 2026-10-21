import { test, expect } from '@playwright/test';
import { prisma, seedMenteeWithRelation, cleanupMenteeWithRelation, seedUser, uniqueEmail, cleanupByEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// #1503: what a relation is for (PLACEMENT | COACHING) and whose outcome a hire
// is (employment attribution). Additive: the attribution is validated when sent
// but not yet required, because no screen sends it (EMPLOYMENT_ATTRIBUTION_REQUIRED).

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
const PW = 'KindPass123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('kind: admin-only reclassification moves funnelEnteredAt; attribution is whitelisted and stored on a hire move', async ({ playwright, baseURL }) => {
  const seeded = await seedMenteeWithRelation('rel-kind', PW);
  const admin = await playwright.request.newContext({ baseURL });
  const mentor = await playwright.request.newContext({ baseURL });
  try {
    expect((await signInViaApi(admin, ADMIN_EMAIL, ADMIN_PASSWORD)).ok).toBe(true);
    expect((await signInViaApi(mentor, seeded.mentorEmail, PW)).ok).toBe(true);
    const url = `/api/mentorship/${seeded.relationId}`;

    // Every existing row is a placement — no count moves.
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } })).kind).toBe('PLACEMENT');

    // The relation's own mentor may not reclassify it.
    const refused = await mentor.put(url, { data: { kind: 'COACHING' } });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('kind_admin_only');
    // …but echoing the current value is a no-op, not a refusal.
    expect((await mentor.put(url, { data: { kind: 'PLACEMENT' } })).status()).toBe(200);

    expect((await admin.put(url, { data: { kind: 'MENTORING' } })).status()).toBe(400);
    expect((await admin.put(url, { data: { kind: 'COACHING' } })).ok()).toBe(true);
    let row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.kind).toBe('COACHING');
    expect(row.funnelEnteredAt).toBeNull();

    const before = Date.now();
    expect((await admin.put(url, { data: { kind: 'PLACEMENT' } })).ok()).toBe(true);
    row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.kind).toBe('PLACEMENT');
    expect(row.funnelEnteredAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    // Attribution: junk refused, on both write paths.
    const junk = await mentor.put(url, { data: { pipelineStatus: 'HIRED_660', employmentAttribution: 'MAYBE' } });
    expect(junk.status()).toBe(400);
    const junk2 = await admin.post('/api/status-changes', {
      data: { relationId: seeded.relationId, fromStatus: 'INTERNSHIP_IN_PROGRESS_450', toStatus: 'HIRED_660', employmentAttribution: 'MAYBE' },
    });
    expect(junk2.status()).toBe(400);

    // Not yet required: a hire move without one still succeeds (the board sends none today).
    expect((await mentor.put(url, { data: { pipelineStatus: 'HIRED_660' } })).ok()).toBe(true);
    row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.pipelineStatus).toBe('HIRED_660');
    expect(row.employmentAttribution).toBeNull();

    // A live move into the hire stage stores a sent attribution.
    const toEmployed = await admin.post('/api/status-changes', {
      data: { relationId: seeded.relationId, fromStatus: 'HIRED_660', toStatus: 'EMPLOYED_700', employmentAttribution: 'SELF_FOUND' },
    });
    expect(toEmployed.ok()).toBe(true);
    row = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: seeded.relationId } });
    expect(row.employmentAttribution).toBe('SELF_FOUND');

    // #810 regression: an off-path move without a reason is still refused.
    const offPath = await mentor.put(url, { data: { pipelineStatus: 'INTERNSHIP_DROPPED_460' } });
    expect(offPath.status()).toBe(400);
  } finally {
    await admin.dispose();
    await mentor.dispose();
    await cleanupMenteeWithRelation(seeded);
  }
});

test('POST /api/mentorship: kind defaults to PLACEMENT with funnelEnteredAt = start; COACHING enters no funnel', async ({ playwright, baseURL }) => {
  const admin = await playwright.request.newContext({ baseURL });
  const emails = [uniqueEmail('rk-mentor'), uniqueEmail('rk-mentee-a'), uniqueEmail('rk-mentee-b')];
  try {
    const mentor = await seedUser(emails[0], PW, 'MENTOR', 'RK Mentor');
    const a = await seedUser(emails[1], PW, 'MENTEE', 'RK Mentee A');
    const b = await seedUser(emails[2], PW, 'MENTEE', 'RK Mentee B');
    expect((await signInViaApi(admin, ADMIN_EMAIL, ADMIN_PASSWORD)).ok).toBe(true);

    const start = '2026-09-01T00:00:00.000Z';
    expect((await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: a.id, startDate: start } })).status()).toBe(201);
    expect((await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: b.id, kind: 'NOPE' } })).status()).toBe(400);
    expect((await admin.post('/api/mentorship', { data: { mentorId: mentor.id, menteeId: b.id, kind: 'COACHING' } })).status()).toBe(201);

    const ra = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: a.id } });
    expect(ra.kind).toBe('PLACEMENT');
    expect(ra.funnelEnteredAt?.toISOString()).toBe(start);
    const rb = await prisma.mentorshipRelation.findFirstOrThrow({ where: { menteeId: b.id } });
    expect(rb.kind).toBe('COACHING');
    expect(rb.funnelEnteredAt).toBeNull();
  } finally {
    await admin.dispose();
    for (const e of emails) await cleanupByEmail(e);
  }
});
