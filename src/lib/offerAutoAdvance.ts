import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { getSetting } from '@/lib/settings';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { DEFAULT_HIRED_STAGE_KEY } from '@/lib/offers';
import { validateDropoffReason } from '@/lib/stageChange';
import { recordStageMove, stageMoveData } from '@/lib/stageMove';
import { decideOfferAutoAdvance, type AutoAdvanceDecision } from '@/lib/offerAutoAdvanceRule';

// An accepted offer moves its relation to the hired stage, when the org opted in
// (`autoAdvanceOnOfferAccept`, #2658). The decision is offerAutoAdvanceRule.ts;
// this is the write, and it goes through the SAME path as a move made by hand
// (src/lib/stageMove.ts): StatusChange row, activity entry, notification,
// webhook and stage SLA.
//
// It runs AFTER the acceptance committed, and nothing here can undo or fail
// it. A candidate saying yes must not be told no because of a pipeline setting,
// the same rule the requisition count follows (hiringOutcome.ts). Every skip is
// logged with its reason, so an admin who expected a move can see why none happened.
//
// The move is the system's (#2527): `changedById` is null. Nobody dragged the
// card. Naming the candidate who accepted would put words in the history they
// never said.
//
// RACES: the write is a conditional `updateMany` on the stage the decision read.
// If someone moved the card in between, it matches nothing and the move is
// skipped. The hand-made move is newer and wins.

export type AutoAdvanceResult = AutoAdvanceDecision | { move: false; reason: 'changed_meanwhile' | 'reason_required' };

export async function advanceOnAcceptedOffer(offer: { id: string; relationId: string; orgId: string | null }): Promise<AutoAdvanceResult> {
  const enabled = (await getSetting('autoAdvanceOnOfferAccept', offer.orgId)) === 'true';
  if (!enabled) return { move: false, reason: 'disabled' };

  const relation = await prisma.mentorshipRelation.findUnique({
    where: { id: offer.relationId },
    select: { id: true, menteeId: true, orgId: true, pipelineStatus: true, status: true, trialStartedAt: true, trialEndsAt: true },
  });
  if (!relation) return { move: false, reason: 'not_active' };

  const stages = await resolvePipelineStages(relation.orgId);
  const decision = decideOfferAutoAdvance({
    enabled,
    hiredKey: DEFAULT_HIRED_STAGE_KEY,
    stages,
    currentStage: relation.pipelineStatus,
    relationStatus: relation.status,
  });
  if (!decision.move) return skipped(offer.id, relation.id, decision);

  // The drop-off check every stage write runs first. The hired stage is never a
  // drop-off in practice; if a tenant flagged it as one, a reason is required
  // and there is nobody to give it, so the move is skipped.
  const reasonCheck = await validateDropoffReason({ orgId: relation.orgId, toStatus: decision.to });
  if (!reasonCheck.ok) return skipped(offer.id, relation.id, { move: false, reason: 'reason_required' });

  const moved = await prisma.mentorshipRelation.updateMany({
    where: { id: relation.id, pipelineStatus: relation.pipelineStatus, status: 'ACTIVE' },
    data: await stageMoveData(relation, decision.to),
  });
  if (moved.count === 0) return skipped(offer.id, relation.id, { move: false, reason: 'changed_meanwhile' });

  await recordStageMove({ relation, toStatus: decision.to, actor: null, cause: `offer ${offer.id} accepted` });
  return decision;
}

async function skipped(offerId: string, relationId: string, result: AutoAdvanceResult): Promise<AutoAdvanceResult> {
  if (!result.move && result.reason !== 'disabled') {
    await logActivity({
      action: 'offer.auto_advance_skipped',
      actorId: null,
      targetType: 'relation',
      targetId: relationId,
      detail: `offer ${offerId}: ${result.reason}`,
    });
  }
  return result;
}
