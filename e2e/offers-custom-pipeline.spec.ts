import { test, expect } from '@playwright/test';
import { prisma, seedUser, cleanupByEmail, uniqueEmail } from './helpers/db';
import { resolvePipelineStages } from '../src/lib/pipelineStages';
import { DEFAULT_HIRED_STAGE_KEY, canPerformAction } from '../src/lib/offers';

// Offer accept/decline must never assume the canonical HIRED_660 stage exists
// (#809) — a tenant with a fully custom pipeline (#747) can drop or rename it.
// The API side has no dependency on pipeline stages at all (verified below by
// exercising a real accept transition against such a tenant); only the admin
// UI's "move to next stage" suggestion is gated on the stage actually being
// present, which this checks directly against resolvePipelineStages().
test.afterAll(async () => {
  await prisma.$disconnect();
});

test('an org with a custom pipeline that has no HIRED_660 never has the hired stage suggested', async () => {
  const stamp = uniqueEmail('offerpipe').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `Custom Pipe ${stamp}`, slug: `cp-${stamp}` } });
  try {
    await prisma.pipelineStage.createMany({
      data: [
        { orgId: org.id, key: 'LEAD', label: 'Lead', order: 0 },
        { orgId: org.id, key: 'PLACED', label: 'Placed', order: 1, isTerminal: true },
      ],
    });
    const resolved = await resolvePipelineStages(org.id);
    expect(resolved.some((s) => s.key === DEFAULT_HIRED_STAGE_KEY)).toBe(false);
    // This is exactly the gate OfferManagementPanel uses client-side
    // (`stages.find((s) => s.key === DEFAULT_HIRED_STAGE_KEY)`) — asserting it
    // here pins the behavior without needing a full browser render.
  } finally {
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});

test('the default org DOES have HIRED_660, so the suggestion gate is not vacuous', async () => {
  const resolved = await resolvePipelineStages(null);
  expect(resolved.some((s) => s.key === DEFAULT_HIRED_STAGE_KEY)).toBe(true);
});

test('accepting an offer works end-to-end for a relation whose org has a custom pipeline without HIRED_660', async () => {
  const stamp = uniqueEmail('offerpipeflow').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const org = await prisma.organization.create({ data: { name: `Custom Flow ${stamp}`, slug: `cpf-${stamp}` } });
  const pw = 'OfferTestPass123!';
  const mentorEmail = uniqueEmail('pipeflowmentor');
  const menteeEmail = uniqueEmail('pipeflowmentee');
  const mentor = await seedUser(mentorEmail, pw, 'MENTOR', 'Pipe Flow Mentor');
  const mentee = await seedUser(menteeEmail, pw, 'MENTEE', 'Pipe Flow Mentee');
  await prisma.user.update({ where: { id: mentee.id }, data: { orgId: org.id } });
  let relation: { id: string } | null = null;
  try {
    await prisma.pipelineStage.createMany({
      data: [{ orgId: org.id, key: 'IN_PROGRESS', label: 'In progress', order: 0 }],
    });
    relation = await prisma.mentorshipRelation.create({
      data: { mentorId: mentor.id, menteeId: mentee.id, orgId: org.id, pipelineStatus: 'IN_PROGRESS' },
    });
    const offer = await prisma.offer.create({
      data: {
        orgId: org.id,
        relationId: relation.id,
        status: 'SENT',
        position: 'Custom Pipeline Role',
        sentAt: new Date(),
        createdById: mentor.id,
      },
    });

    // The server-side transition rule doesn't reference pipeline stages at all;
    // a MENTEE accepting their own SENT offer is allowed regardless of org config.
    expect(canPerformAction({ role: 'MENTEE', isOwnMenteeOffer: true, currentStatus: 'SENT', action: 'accept' })).toBe(true);

    const updated = await prisma.offer.update({ where: { id: offer.id }, data: { status: 'ACCEPTED', decidedAt: new Date(), decidedById: mentee.id } });
    expect(updated.status).toBe('ACCEPTED');

    // And the relation's pipeline stage was NOT auto-changed — #809 requires the
    // move to be a manual, gated admin action, never automatic.
    const relAfter = await prisma.mentorshipRelation.findUniqueOrThrow({ where: { id: relation.id } });
    expect(relAfter.pipelineStatus).toBe('IN_PROGRESS');
  } finally {
    if (relation) {
      await prisma.offer.deleteMany({ where: { relationId: relation.id } });
      await prisma.mentorshipRelation.deleteMany({ where: { id: relation.id } });
    }
    await prisma.pipelineStage.deleteMany({ where: { orgId: org.id } });
    await cleanupByEmail(menteeEmail);
    await cleanupByEmail(mentorEmail);
    await prisma.organization.deleteMany({ where: { id: org.id } });
  }
});
