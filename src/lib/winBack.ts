import { prisma } from '@/lib/prisma';
import { findActiveMentorship, AlreadyMentoredError } from '@/lib/activeMentorship';
import { ENDED_CHURNED } from '@/lib/relationLifecycle';
import { stageTrialWindow } from '@/lib/trialWindow';
import { stageDeadlineUpdate } from '@/lib/stageSla';
import type { WinBackStage } from '@/lib/winBackRule';

// The Prisma half of a win-back (#2842); the rule is src/lib/winBackRule.ts.
// One transaction: close the lost journey, re-ask the one-active-mentor
// question INSIDE it (#419, src/lib/activeMentorship.ts), open the new one.
// Nothing is copied across but the account, the lead and the owner — a win-back
// is a new journey, so its trial window, deal value and notice period start
// empty. No StatusChange for the new relation: a relation CREATED at a stage
// has no move to record (stageEnteredAt() reads `startDate`).

export async function winBack(input: {
  relationId: string;
  toStage: WinBackStage;
  /** Expected state of the lost relation, so a concurrent move cannot be overwritten. */
  expect: { pipelineStatus: string };
}): Promise<{ newRelationId: string }> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const old = await tx.mentorshipRelation.findUniqueOrThrow({
      where: { id: input.relationId },
      select: { id: true, orgId: true, mentorId: true, menteeId: true, companyId: true },
    });
    const closed = await tx.mentorshipRelation.updateMany({
      where: { id: old.id, status: 'ACTIVE', pipelineStatus: input.expect.pipelineStatus },
      data: { status: 'COMPLETED', lifecycleState: ENDED_CHURNED, completedAt: now },
    });
    if (closed.count === 0) throw new WinBackConflictError();

    const other = await findActiveMentorship(tx, old.menteeId, { exceptRelationId: old.id });
    if (other) throw new AlreadyMentoredError(old.menteeId, other.id);

    const trialWindow = await stageTrialWindow({ orgId: old.orgId, toStage: input.toStage, enteredAt: now, existing: null });
    const deadline = await stageDeadlineUpdate(old.orgId, input.toStage, now);
    const created = await tx.mentorshipRelation.create({
      data: {
        orgId: old.orgId,
        mentorId: old.mentorId,
        menteeId: old.menteeId,
        companyId: old.companyId,
        pipelineStatus: input.toStage,
        startDate: now,
        previousRelationId: old.id,
        ...trialWindow,
        ...(deadline ?? {}),
      },
      select: { id: true },
    });
    return { newRelationId: created.id };
  });
}

export class WinBackConflictError extends Error {
  constructor() {
    super('The lost record changed meanwhile');
  }
}
