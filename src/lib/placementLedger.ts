// The placement ledger's only writer of the stamp (#1765, docs/placements.md).
//
// Called by the `placement` subscriber of `pipeline.stage_change`
// (src/lib/events/subscribers/placement.ts), so EVERY stage write path — the
// board, the stage select, bulk advance, the accepted-offer auto-advance, the
// interview outcome, the account-event feed — stamps through the same code,
// because every one of them already routes through `emitStageChange()`.
//
// It reconciles rather than reacts: it reads the relation as it is NOW and lets
// `reconcilePlacement()` (src/lib/placementRule.ts) decide. A redelivered or
// out-of-order event therefore lands on the same row (at-least-once safe), and
// the unique `relationId` turns a concurrent double-create into one row.
//
// Observes only: no stage write, no relation status change, no notification.
// Server-only.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runWithOrg } from '@/lib/orgContext';
import { outcomeStageKeys } from '@/lib/pipelineStages';
import { verticalFor } from '@/lib/verticalContext';
import { verticalHasCapability } from '@/lib/verticals';
import { effectiveAttribution, initialLedgerState, reconcilePlacement, type PlacementAction } from '@/lib/placementRule';

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Reconcile one relation's placement with its current stage. Returns what it did. */
export async function syncPlacementForRelation(relationId: string, now: Date = new Date()): Promise<PlacementAction['kind']> {
  const relation = await prisma.mentorshipRelation.findUnique({
    where: { id: relationId },
    select: {
      id: true,
      orgId: true,
      menteeId: true,
      mentorId: true,
      companyId: true,
      pipelineStatus: true,
      kind: true,
      employmentAttribution: true,
      mentee: { select: { sourceId: true } },
    },
  });
  // A relation removed since the event, or one that belongs to no tenant
  // (Placement.orgId is required): nothing to account for.
  if (!relation || !relation.orgId) return 'none';
  const orgId = relation.orgId;

  return runWithOrg(orgId, async () => {
    // A sale is not a hire: a vertical without the `placements` module (the
    // MARKETING sales book) has no ledger, the same line
    // `validateEmploymentAttribution()` draws.
    if (!verticalHasCapability(await verticalFor(orgId), 'placements')) return 'none';

    const { finished } = await outcomeStageKeys(orgId);
    // COACHING is mentoring with no placement goal (#1503): it never counts.
    const inHireStage = relation.kind !== 'COACHING' && finished.includes(relation.pipelineStatus);
    const existing = await prisma.placement.findUnique({
      where: { relationId },
      select: { id: true, reversedAt: true },
    });
    const action = reconcilePlacement({ inHireStage, existing });

    switch (action.kind) {
      case 'create': {
        // The offer that made the hire, when there is one: it names the role
        // and, if the relation carries no company, the employer.
        const offer = await prisma.offer.findFirst({
          where: { relationId, status: 'ACCEPTED' },
          orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }],
          select: { id: true, requisitionId: true, companyId: true },
        });
        const attribution = effectiveAttribution(relation.employmentAttribution);
        try {
          await prisma.placement.create({
            data: {
              orgId,
              relationId,
              menteeId: relation.menteeId,
              companyId: relation.companyId ?? offer?.companyId ?? null,
              offerId: offer?.id ?? null,
              requisitionId: offer?.requisitionId ?? null,
              creditedMentorId: relation.mentorId,
              sourceId: relation.mentee?.sourceId ?? null,
              placedAt: now,
              attribution,
              ...initialLedgerState(attribution),
            },
          });
        } catch (e) {
          // A concurrent delivery created it first — exactly one row, as wanted.
          if (isUniqueViolation(e)) return 'none';
          throw e;
        }
        return 'create';
      }
      case 'reinstate':
        // Guarded on the state we read, so two deliveries cannot both act.
        await prisma.placement.updateMany({ where: { relationId, reversedAt: { not: null } }, data: { reversedAt: null } });
        return 'reinstate';
      case 'reverse':
        await prisma.placement.updateMany({ where: { relationId, reversedAt: null }, data: { reversedAt: now } });
        return 'reverse';
      default:
        return 'none';
    }
  });
}
