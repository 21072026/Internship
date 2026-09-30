import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logActivity } from '@/lib/activity';
import { emitStageChange } from '@/lib/stageChangeEffects';
import { stageTrialWindow } from '@/lib/trialWindow';
import { statusChangeData } from '@/lib/stageChange';

// A single relation moving one stage, as ONE write path (#2658).
//
// This is what `PUT /api/mentorship/[id]` did inline: the column patch (the
// stage, plus the trial window a move into TRIAL_ACTIVE stamps, #2551), and
// after the write the audit row (#934), the activity entry and the shared
// effects: notification, webhook and stage deadline/SLA (#926). It was
// extracted so that a second caller, the accepted-offer auto-advance, does not
// hand-roll a fork of it (#1880 is what those forks cost).
//
// It is two halves on purpose, because callers write differently. The PUT
// merges the stage into a bigger update inside its own #419 transaction; the
// auto-advance issues a guarded `updateMany`. Both callers take the patch, write
// it however they must, and only then call `recordStageMove`. The drop-off
// reason check (`validateDropoffReason`) stays with the caller, BEFORE any
// write, because a refused reason must never leave a moved relation behind.

export interface StageMoveRelation {
  id: string;
  menteeId: string;
  orgId: string | null;
  /** The stage BEFORE the move: the audit row's `fromStatus`. */
  pipelineStatus: string;
  trialStartedAt?: Date | null;
  trialEndsAt?: Date | null;
}

/** The columns a move to `toStatus` writes. The caller has already established that it IS a move. */
export async function stageMoveData(
  relation: StageMoveRelation,
  toStatus: string,
  enteredAt: Date = new Date(),
): Promise<Prisma.MentorshipRelationUncheckedUpdateInput> {
  return {
    pipelineStatus: toStatus,
    ...(await stageTrialWindow({
      orgId: relation.orgId,
      toStage: toStatus,
      enteredAt,
      existing: relation,
    })),
  };
}

/**
 * Everything that follows a committed move: the StatusChange row, the activity
 * entry, and the notification, webhook and SLA effects. Call it only after the
 * write committed. `relation` still carries the old stage.
 */
export async function recordStageMove(opts: {
  relation: StageMoveRelation;
  toStatus: string;
  /** `null` for a move the system made on its own (#2527): never a stand-in person. */
  actor: { id: string; email?: string | null } | null;
  reasonCode?: string | null;
  reasonNote?: string | null;
  /** The same request set `stageDeadline` by hand, so the stage default must not overwrite it (#817). */
  deadlineSetByCaller?: boolean;
  /** Extra words for the activity line, e.g. what caused a move nobody dragged. */
  cause?: string;
}): Promise<void> {
  const { relation, toStatus, actor } = opts;
  const auditRow = statusChangeData({
    relationId: relation.id,
    fromStatus: relation.pipelineStatus,
    toStatus,
    changedById: actor?.id ?? null,
    reasonCode: opts.reasonCode ?? undefined,
    reasonNote: opts.reasonNote ?? undefined,
  });
  // statusChangeData refuses a from === to entry, so this is the same no-op
  // guard every stage write path shares.
  if (!auditRow) return;
  await prisma.statusChange.create({ data: auditRow });
  await logActivity({
    action: 'pipeline.stage_change',
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    targetType: 'relation',
    targetId: relation.id,
    detail: `${relation.pipelineStatus} → ${toStatus}${opts.cause ? ` (${opts.cause})` : ''}`,
  });
  await emitStageChange({
    relationId: relation.id,
    menteeId: relation.menteeId,
    orgId: relation.orgId,
    from: relation.pipelineStatus,
    to: toStatus,
    reasonCode: opts.reasonCode,
    deadlineSetByCaller: opts.deadlineSetByCaller,
  });
}
