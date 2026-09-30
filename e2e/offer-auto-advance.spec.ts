import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { signInViaApi } from './helpers/auth';

// Accepted offer → hired stage, opt-in (#2658). The move must go through the
// same write path as a move made by hand: stage, StatusChange row, activity
// entry, stage SLA and the mentee's notification. With the setting off nothing
// changes; a pipeline without the hired stage is left alone and the skip is
// logged, never thrown.

const PW = 'AutoAdvance123!';

test.afterAll(async () => {
  await prisma.$disconnect();
});

async function seed(prefix: string, opts: { autoAdvance: boolean; customPipeline?: boolean }) {
  const org = await prisma.organization.create({
    data: { name: `AA ${prefix} ${Date.now()}`, slug: `aa-${prefix}-${Date.now()}-${Math.round(Math.random() * 1e4)}` },
  });
  if (opts.customPipeline) {
    await prisma.pipelineStage.createMany({
      data: ['SOURCED', 'OFFERED', 'PLACED'].map((key, i) => ({
        orgId: org.id, key, label: key, order: i, isTerminal: i === 2, isOffPath: false,
      })),
    });
  }
  if (opts.autoAdvance) {
    await prisma.setting.create({ data: { orgId: org.id, key: 'autoAdvanceOnOfferAccept', value: 'true' } });
  }
  // An SLA on the hired stage, so the test can see the shared effects ran.
  await prisma.stageSla.create({ data: { orgId: org.id, stageKey: 'HIRED_660', days: 14 } });
  const adminEmail = uniqueEmail(`aa-${prefix}-admin`);
  const mentorEmail = uniqueEmail(`aa-${prefix}-mentor`);
  const menteeEmail = uniqueEmail(`aa-${prefix}-mentee`);
  const admin = await seedUser(adminEmail, PW, 'ADMIN', 'AA Admin', org.id);
  const mentor = await seedUser(mentorEmail, PW, 'MENTOR', 'AA Mentor', org.id);
  const mentee = await seedUser(menteeEmail, PW, 'MENTEE', 'AA Mentee', org.id);
  const relation = await prisma.mentorshipRelation.create({
    data: {
      orgId: org.id, mentorId: mentor.id, menteeId: mentee.id,
      pipelineStatus: opts.customPipeline ? 'OFFERED' : 'HIREABLE_600',
    },
  });
  const offer = await prisma.offer.create({
    data: { orgId: org.id, relationId: relation.id, position: 'Engineer', status: 'SENT', sentAt: new Date(), createdById: admin.id },
  });
  return {
    org, admin, mentee, relation, offer, adminEmail,
    cleanup: async () => {
      await prisma.auditLog.deleteMany({ where: { targetId: offer.id } });
      await prisma.activityLog.deleteMany({ where: { targetId: { in: [relation.id, offer.id] } } });
      await prisma.offer.deleteMany({ where: { relationId: relation.id } });
      await prisma.statusChange.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
      for (const e of [menteeEmail, mentorEmail, adminEmail]) await cleanupByEmail(e);
      await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => {});
    },
  };
}

test('off (the default): an accepted offer moves nothing', async ({ request }) => {
  const s = await seed('off', { autoAdvance: false });
  try {
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);
    expect((await request.patch(`/api/offers/${s.offer.id}`, { data: { action: 'accept' } })).status()).toBe(200);
    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } });
    expect(rel.pipelineStatus).toBe('HIREABLE_600');
    expect(await prisma.statusChange.count({ where: { relationId: s.relation.id } })).toBe(0);
    expect(await prisma.activityLog.count({ where: { action: 'offer.auto_advance_skipped', targetId: s.relation.id } })).toBe(0);
  } finally {
    await s.cleanup();
  }
});

test('on: the relation moves to HIRED_660 with history, SLA and the mentee notification', async ({ request }) => {
  const s = await seed('on', { autoAdvance: true });
  try {
    const before = new Date();
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);
    expect((await request.patch(`/api/offers/${s.offer.id}`, { data: { action: 'accept' } })).status()).toBe(200);

    const rel = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } });
    expect(rel.pipelineStatus).toBe('HIRED_660');
    // The stage SLA from the shared effects: 14 days from the move.
    expect(rel.stageDeadline).not.toBeNull();
    expect(rel.stageDeadline!.getTime()).toBeGreaterThan(before.getTime() + 13 * 86_400_000);

    const changes = await prisma.statusChange.findMany({ where: { relationId: s.relation.id } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ fromStatus: 'HIREABLE_600', toStatus: 'HIRED_660', changedById: null });

    const activity = await prisma.activityLog.findFirst({ where: { action: 'pipeline.stage_change', targetId: s.relation.id } });
    expect(activity?.detail).toContain(`offer ${s.offer.id} accepted`);
    expect(await prisma.notification.count({ where: { userId: s.mentee.id, createdAt: { gte: before } } })).toBeGreaterThan(0);

    // The acceptance itself is unchanged: the offer is ACCEPTED either way.
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: s.offer.id } })).status).toBe('ACCEPTED');
  } finally {
    await s.cleanup();
  }
});

test('on, already past the hired stage: never moves backwards', async ({ request }) => {
  const s = await seed('past', { autoAdvance: true });
  try {
    await prisma.mentorshipRelation.update({ where: { id: s.relation.id }, data: { pipelineStatus: 'EMPLOYED_700' } });
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);
    expect((await request.patch(`/api/offers/${s.offer.id}`, { data: { action: 'accept' } })).status()).toBe(200);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } })).pipelineStatus).toBe('EMPLOYED_700');
    expect(await prisma.statusChange.count({ where: { relationId: s.relation.id } })).toBe(0);
  } finally {
    await s.cleanup();
  }
});

test('on, custom pipeline without a hired stage: nothing moves, nothing throws, the skip is logged', async ({ request }) => {
  const s = await seed('custom', { autoAdvance: true, customPipeline: true });
  try {
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);
    expect((await request.patch(`/api/offers/${s.offer.id}`, { data: { action: 'accept' } })).status()).toBe(200);
    expect((await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: s.relation.id } })).pipelineStatus).toBe('OFFERED');
    expect(await prisma.statusChange.count({ where: { relationId: s.relation.id } })).toBe(0);
    const skip = await prisma.activityLog.findFirst({ where: { action: 'offer.auto_advance_skipped', targetId: s.relation.id } });
    expect(skip?.detail).toContain('no_hired_stage');
  } finally {
    await s.cleanup();
  }
});

test('the setting is exposed by the admin settings API, off by default, and a bad value is refused', async ({ request }) => {
  // Deliberately no successful PUT here: until #2628 lands, the settings PUT
  // writes the GLOBAL row, and a 'true' there would switch this on for every
  // org in the run (the "off" test above included).
  const s = await seed('settings', { autoAdvance: false });
  try {
    expect((await signInViaApi(request, s.adminEmail, PW)).ok).toBe(true);
    const current = await (await request.get('/api/admin/settings')).json();
    expect(current.settings.autoAdvanceOnOfferAccept).toBe('false');
    expect((await request.put('/api/admin/settings', { data: { autoAdvanceOnOfferAccept: 'yes' } })).status()).toBe(400);
  } finally {
    await s.cleanup();
  }
});
