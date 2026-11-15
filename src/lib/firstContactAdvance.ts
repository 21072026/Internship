// First-contact auto-advance (#3746) — the Prisma half. The decision is
// src/lib/firstContactAdvanceRule.ts; this reads the facts it needs, makes the
// move through the shared stage write path and nothing else.
//
// THE ONE WRITER. Every path that creates an InteractionLog a person or a
// bridge produced calls `advanceOnFirstContact()` right after the row exists:
// createInteraction() (POST /api/interactions, POST /api/v1/interactions, the
// chat "log it" card), the mentor e-mail composer, the CRM BCC bridge and the
// meeting auto-log. History imports and sample data do not — a migrated past
// is not a contact made now.
//
// HOW IT MOVES. stageMoveData() for the columns, a guarded updateMany whose
// WHERE names the expected first stage and an active relation, then
// recordStageMove() — the StatusChange row, the `pipeline.stage_change`
// activity and its effects, exactly what a drag on the board produces. The
// guard is what makes it idempotent: the same interaction handled twice, or two
// interactions logged at once, move the lead once; the loser matches no row.
// actor is null (a move the system made, #2527) and the activity line names the
// interaction that caused it.
//
// NO LOOP: the automation engine reacting to that stage change cannot move a
// stage (docs/automation-rules.md — its action allowlist has no such action),
// and this function runs on interaction creation, never on a stage change.
//
// DORMANCY is not written here: sweepDormantFirstContacts() stays the one writer
// of `dormantSince`. A lead that left the first stage no longer matches the
// dormant rule, so the next sweep clears its stamp.

import { prisma } from '@/lib/prisma';
import { shellCapabilities } from '@/lib/shellCapabilities';
import { resolveSettingRaw } from '@/lib/settingsResolver';
import { resolvePipelineStages } from '@/lib/pipelineStages';
import { startStageKey } from '@/lib/pipeline';
import { activeRelationWhere } from '@/lib/relationLifecycle';
import { recordStageMove, stageMoveData } from '@/lib/stageMove';
import { decideFirstContactAdvance, firstContactAdvanceApplies, isFirstContactType } from '@/lib/firstContactAdvanceRule';

/** What the caller may tell the person who logged the interaction (a toast with "Undo"). */
export interface FirstContactAdvance {
  relationId: string;
  from: string;
  to: string;
}

export async function advanceOnFirstContact(input: {
  relationId: string;
  interactionId: string;
  type: string;
}): Promise<FirstContactAdvance | null> {
  // Cheap exits first: most interactions are not first contacts.
  if (!isFirstContactType(input.type)) return null;
  const relation = await prisma.mentorshipRelation.findUnique({
    where: { id: input.relationId },
    select: {
      id: true,
      orgId: true,
      menteeId: true,
      status: true,
      lifecycleState: true,
      pipelineStatus: true,
      trialStartedAt: true,
      trialEndsAt: true,
    },
  });
  if (!relation) return null;
  const caps = await shellCapabilities(relation.orgId);
  if (!firstContactAdvanceApplies(caps)) return null;

  const scope = { orgId: relation.orgId };
  const [mode, targetStage, stages] = await Promise.all([
    resolveSettingRaw('firstContactAutoAdvance', scope),
    resolveSettingRaw('firstContactTargetStage', scope),
    resolvePipelineStages(relation.orgId),
  ]);
  const active = activeRelationWhere();
  const decision = decideFirstContactAdvance({
    caps,
    mode,
    targetStage,
    interactionType: input.type,
    relationActive: relation.status === active.status && relation.lifecycleState === active.lifecycleState,
    currentStage: relation.pipelineStatus,
    startKey: startStageKey(stages),
    stages,
  });
  if (!decision.move) return null;

  const data = await stageMoveData(relation, decision.to);
  const claimed = await prisma.mentorshipRelation.updateMany({
    // The expected first stage in the WHERE: a concurrent move, a second log of
    // the same contact or a hand move in between all leave this matching nothing.
    where: { id: relation.id, pipelineStatus: decision.from, ...active },
    data,
  });
  if (claimed.count === 0) return null;
  await recordStageMove({
    relation,
    toStatus: decision.to,
    actor: null,
    cause: `automatic: first contact — ${input.type} interaction ${input.interactionId}`,
  });
  return { relationId: relation.id, from: decision.from, to: decision.to };
}
