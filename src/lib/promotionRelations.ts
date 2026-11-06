// The server half of #1506 (the rule is promotionRelationsRule.ts): read a
// person's open mentee relations, and apply the admin's choice inside the
// promotion's own transaction, so the role and the relations change together
// or not at all.

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { notify } from '@/lib/notify';
import { raiseLifecycleChanged } from '@/lib/lifecycleEvents';
import { funnelEnteredAtForKindChange } from '@/lib/placementKind';
import {
  ENDED_EARLY,
  effectiveLifecycleState,
  lifecycleNotificationType,
  stageClockPatch,
  statusForLifecycle,
  type RelationLifecycleState,
} from '@/lib/relationLifecycle';
import { PROMOTION_END_REASON, type PromotionChoice } from '@/lib/promotionRelationsRule';

type Db = Prisma.TransactionClient | typeof prisma;

/** What the admin is shown: the relation, its mentor's name and its stage. No contact data. */
export interface OpenMenteeRelation {
  id: string;
  mentorName: string;
  pipelineStatus: string;
  kind: string;
}

/** The account's open (ACTIVE or PAUSED — `status: ACTIVE`) relations in which it is the mentee. */
export async function openMenteeRelations(db: Db, userId: string): Promise<OpenMenteeRelation[]> {
  const rows = await db.mentorshipRelation.findMany({
    where: { menteeId: userId, status: 'ACTIVE' },
    orderBy: { startDate: 'asc' },
    select: { id: true, pipelineStatus: true, kind: true, mentor: { select: { fullName: true } } },
  });
  return rows.map((r) => ({ id: r.id, mentorName: r.mentor.fullName, pipelineStatus: r.pipelineStatus, kind: r.kind }));
}

/** A relation END closed, for the follow-ups that run after the commit. */
export interface EndedRelation {
  relationId: string;
  orgId: string | null;
  /** An open relation is live: ACTIVE or PAUSED. */
  from: Extract<RelationLifecycleState, 'ACTIVE' | 'PAUSED'>;
  mentorId: string;
  menteeName: string;
}

export class PromotionConflictError extends Error {}

/**
 * Apply `choice` to the account's open mentee relations, inside `tx`. Returns
 * the ids it changed and the relations it ended. Throws PromotionConflictError
 * when a relation moved between the read and the write (the transaction rolls
 * the promotion back with it).
 */
export async function applyPromotionChoice(
  tx: Prisma.TransactionClient,
  input: { userId: string; choice: PromotionChoice; actorId: string; now?: Date },
): Promise<{ changed: string[]; ended: EndedRelation[] }> {
  const now = input.now ?? new Date();
  if (input.choice === 'KEEP') return { changed: [], ended: [] };
  const rows = await tx.mentorshipRelation.findMany({
    where: { menteeId: input.userId, status: 'ACTIVE' },
    select: {
      id: true,
      orgId: true,
      kind: true,
      status: true,
      lifecycleState: true,
      stageDeadline: true,
      stageDeadlineRemainingDays: true,
      mentorId: true,
      mentee: { select: { fullName: true } },
    },
  });

  if (input.choice === 'COACHING') {
    const changed: string[] = [];
    for (const r of rows) {
      if (r.kind === 'COACHING') continue;
      const entered = funnelEnteredAtForKindChange(r.kind, 'COACHING', now);
      await tx.mentorshipRelation.update({
        where: { id: r.id },
        data: { kind: 'COACHING', ...(entered !== undefined ? { funnelEnteredAt: entered } : {}) },
      });
      changed.push(r.id);
    }
    return { changed, ended: [] };
  }

  // END: the lifecycle route's own write (src/app/api/mentorship/[id]/lifecycle),
  // so the pairing reads exactly as if it had been ended there.
  const ended: EndedRelation[] = [];
  for (const r of rows) {
    // status ACTIVE reads as ACTIVE or PAUSED, never a terminal state.
    const from = effectiveLifecycleState(r) as EndedRelation['from'];
    const moved = await tx.mentorshipRelation.updateMany({
      where: { id: r.id, status: r.status, lifecycleState: r.lifecycleState },
      data: {
        lifecycleState: ENDED_EARLY,
        status: statusForLifecycle(ENDED_EARLY),
        pausedAt: null,
        ...stageClockPatch(from, ENDED_EARLY, r, now),
        completedAt: now,
        endReasonCode: PROMOTION_END_REASON,
      },
    });
    if (moved.count !== 1) throw new PromotionConflictError();
    await tx.relationLifecycleEvent.create({
      data: { relationId: r.id, fromState: from, toState: ENDED_EARLY, reasonCode: PROMOTION_END_REASON, reasonNote: null, changedById: input.actorId },
    });
    ended.push({ relationId: r.id, orgId: r.orgId, from, mentorId: r.mentorId, menteeName: r.mentee.fullName });
  }
  return { changed: ended.map((e) => e.relationId), ended };
}

/** After the commit: the lifecycle event and the mentor's notice, as the lifecycle route sends them. */
export async function afterPromotionEnded(ended: readonly EndedRelation[], actorId: string): Promise<void> {
  for (const e of ended) {
    await raiseLifecycleChanged({ relationId: e.relationId, orgId: e.orgId, from: e.from, to: ENDED_EARLY, reasonCode: PROMOTION_END_REASON, actorId });
    await notify(e.mentorId, lifecycleNotificationType(e.from, 'ENDED_EARLY'), { name: e.menteeName }, '/mentor');
  }
}
