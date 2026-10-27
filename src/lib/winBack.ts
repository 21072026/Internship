import { prisma } from '@/lib/prisma';
import { inTransaction, type Db } from '@/lib/dbHandle';
import { findActiveMentorship, AlreadyMentoredError } from '@/lib/activeMentorship';
import { ENDED_CHURNED } from '@/lib/relationLifecycle';
import { stageTrialWindow } from '@/lib/trialWindow';
import { stageDeadlineUpdate } from '@/lib/stageSla';
import type { WinBackStage } from '@/lib/winBackRule';

// The Prisma half of a win-back (#2842); the rule is src/lib/winBackRule.ts.
// One transaction: re-ask the one-active-mentor question INSIDE it (#419,
// src/lib/activeMentorship.ts), close the lost journey, open the new one —
// every refusal answered before the first write (#2988).
// Nothing is copied across but the account, the lead and the owner — a win-back
// is a new journey, so its trial window, deal value and notice period start
// empty. No StatusChange for the new relation: a relation CREATED at a stage
// has no move to record (stageEnteredAt() reads `startDate`).
//
// The ONE writer of a new journey (#2966): the person's "win back" button and
// the account-event feed (src/lib/accountEventIngest.ts — a `reactivated`, a
// `converted` on a lost record, a new trial after an expired or closed one)
// both come here. The feed's extras are options, never a second copy:
//   • `at` dates the close and the new start (a historic replay);
//   • `quiet` sets no stage deadline (a historic replay rings nothing);
//   • `trialWindow` is the window the event itself carries;
//   • `expect.closed` accepts a predecessor that is already closed (a person
//     completed it): it is chained, not closed a second time;
//   • `db` joins a caller's transaction (the batch dry run, src/lib/dbHandle.ts).

export async function winBack(input: {
  relationId: string;
  toStage: WinBackStage;
  /**
   * Expected state of the predecessor, so a concurrent move cannot be
   * overwritten: its stage while it is still ACTIVE, or `closed: true` for one
   * that is already closed (then only its being closed is checked).
   */
  expect: { pipelineStatus: string; closed?: boolean };
  /** The moment the old journey ends and the new one starts; omitted = now. */
  at?: Date;
  /** Set no stage deadline on the new journey. */
  quiet?: boolean;
  /** The new journey's trial window; omitted = the stage's own default. */
  trialWindow?: { trialStartedAt?: Date | null; trialEndsAt?: Date | null };
  db?: Db;
}): Promise<{ newRelationId: string }> {
  const now = input.at ?? new Date();
  const done = await inTransaction(input.db ?? prisma, async (tx) => {
    // FIRST, before any plain read: lock the predecessor. Two win-backs of one
    // record then run one after the other, and the second one's reads (its
    // snapshot is taken at its first plain read, i.e. after this lock is
    // granted) see the journey the first one opened — so the #419 question
    // below refuses it. An ACTIVE predecessor was already serialized by the
    // guarded close; a CLOSED one (`expect.closed`) is written nowhere, and
    // without this lock two concurrent events could each open a journey.
    await tx.$queryRaw`SELECT id FROM \`MentorshipRelation\` WHERE id = ${input.relationId} FOR UPDATE`;
    const old = await tx.mentorshipRelation.findUniqueOrThrow({
      where: { id: input.relationId },
      select: { id: true, orgId: true, mentorId: true, menteeId: true, companyId: true, status: true, pipelineStatus: true },
    });
    // Every refusal is decided BEFORE the first write and answered, not thrown
    // from inside the unit: joined to a caller's transaction (the batch dry
    // run) there is no savepoint to roll a refusal's earlier writes back to
    // (src/lib/dbHandle.ts). The order of the answers is the one the close-first
    // version gave: a changed record before another active one.
    const changed = input.expect.closed
      ? old.status === 'ACTIVE'
      : old.status !== 'ACTIVE' || old.pipelineStatus !== input.expect.pipelineStatus;
    if (changed) return { refused: 'changed' as const };

    const other = await findActiveMentorship(tx, old.menteeId, { exceptRelationId: old.id });
    if (other) return { refused: 'mentored' as const, menteeId: old.menteeId, otherId: other.id };

    if (!input.expect.closed) {
      // Still guarded: the authority on "changed" is this conditional write,
      // and as the unit's first write a refusal here leaves nothing behind.
      const closed = await tx.mentorshipRelation.updateMany({
        where: { id: old.id, status: 'ACTIVE', pipelineStatus: input.expect.pipelineStatus },
        data: { status: 'COMPLETED', lifecycleState: ENDED_CHURNED, completedAt: now },
      });
      if (closed.count === 0) return { refused: 'changed' as const };
    }

    const trialWindow =
      input.trialWindow ?? (await stageTrialWindow({ orgId: old.orgId, toStage: input.toStage, enteredAt: now, existing: null }));
    const deadline = input.quiet ? null : await stageDeadlineUpdate({ orgId: old.orgId, mentorId: old.mentorId }, input.toStage, now);
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
  if ('refused' in done) {
    if (done.refused === 'mentored') throw new AlreadyMentoredError(done.menteeId, done.otherId);
    throw new WinBackConflictError();
  }
  return { newRelationId: done.newRelationId };
}

export class WinBackConflictError extends Error {
  constructor() {
    super('The lost record changed meanwhile');
  }
}
