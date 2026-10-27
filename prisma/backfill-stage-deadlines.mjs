// Give a stage deadline to the relations that were already sitting in a stage
// when its service level was configured (#1640).
//
// `stageDeadline` is written on a MOVE (src/lib/stageSla.ts →
// stageChangeEffects). A relation parked in a stage since before the org set
// its SLA therefore never got one, so the aging report and the breach queue
// stayed empty for weeks and the feature looked broken. This fills exactly
// those: ACTIVE relations (not paused, not in the re-engagement pool) with
// `stageDeadline = NULL` whose own scope resolves a service level for the stage
// they are in — the same precedence the request path uses (mentor+cohort →
// mentor → cohort → org, prisma/stage-sla-rule.mjs ≡ src/lib/stageSlaRule.ts).
//
// THE DEADLINE COUNTS FROM THE DAY THE RELATION ENTERED THE STAGE — the newest
// real StatusChange, floored at startDate, i.e. `stageEnteredAt()` of
// src/lib/stageClock.ts — never from now. A candidate parked for ninety days
// must read overdue, not compliant. (The issue suggested `updatedAt` as the
// fallback; startDate is what every "days in stage" surface already uses, so
// the backfilled deadline and the board's day count cannot disagree. The log
// says which one each row came from.)
//
// NO MAIL STORM. A deadline that is already past when it is written would be
// picked up by the next 09:00 sweep (checkStageDeadlineReminders) and mail
// every mentor at once, and the escalation ladder would then mail the admins
// for every breach whose `escalateAfterDays` is long gone. So for a past-due
// deadline, in the same write:
//   · `deadlineReminderSentAt = <run time>` — the sweep reads a set stamp as
//     "the mentor was told" (`mentorAlreadyTold`, src/lib/slaLadderRule.ts) and
//     ADOPTS the breach at level 1 silently. The aging report still shows the
//     relation overdue on its next load: it reads `stageDeadline`.
//   · where the org has an escalation rung for that stage, the breach row is
//     opened here with `snoozedUntil = run time + escalateAfterDays` — "no
//     escalation before this instant" is that column's documented meaning — so
//     the admins get the same grace from the day the deadline became known
//     that a live breach gives them, instead of a backlog in one morning.
//     (`@@unique([relationId, dueAt])` + skipDuplicates keeps it idempotent.)
// A deadline still in the future gets neither: when it passes, the mentor is
// reminded exactly as for any other.
//
// IDEMPOTENT: the write is a guarded `updateMany … where stageDeadline: null`,
// so a second run (or a move that landed in between) changes nothing. The
// registry runs it ONCE per environment (prisma/backfills/registry.mjs) — a
// deadline somebody later clears by hand, or that the account-event feed leaves
// empty on purpose, is not refilled on every deploy.
//
// Dry run by default (`--dry-run` says so explicitly): prints counts per org
// and per stage and writes nothing. `--apply` writes.
import { PrismaClient } from '@prisma/client';
import { planStageDeadline } from './stage-sla-rule.mjs';

const DAY = 24 * 60 * 60 * 1000;
const BATCH = 500;

async function main() {
  const prisma = new PrismaClient();
  const apply = process.argv.includes('--apply') && !process.argv.includes('--dry-run');
  const now = new Date();
  const mode = apply ? 'apply' : 'dry-run';

  try {
    const orgIds = (
      await prisma.stageSla.findMany({ where: { days: { not: null } }, select: { orgId: true }, distinct: ['orgId'] })
    ).map((r) => r.orgId);
    if (orgIds.length === 0) {
      console.log(`backfill-stage-deadlines (${mode}): no org has a service level, nothing to do.`);
      return;
    }

    let total = 0;
    let pastDue = 0;
    let fromStartDate = 0;
    for (const orgId of orgIds) {
      const rows = await prisma.stageSla.findMany({
        where: { orgId, days: { not: null } },
        select: { stageKey: true, days: true, cohortId: true, mentorId: true },
      });
      // Escalation rungs stay org-level (resolveStageEscalations reads scope "org").
      const escalations = new Map(
        (
          await prisma.stageSla.findMany({
            where: { orgId, scope: 'org', days: { not: null }, escalateAfterDays: { gt: 0 } },
            select: { stageKey: true, escalateAfterDays: true },
          })
        ).map((r) => [r.stageKey, r.escalateAfterDays])
      );
      const stageKeys = Array.from(new Set(rows.map((r) => r.stageKey)));
      const perStage = new Map();

      let cursor;
      for (;;) {
        const relations = await prisma.mentorshipRelation.findMany({
          where: {
            orgId,
            status: 'ACTIVE',
            lifecycleState: 'ACTIVE',
            stageDeadline: null,
            pipelineStatus: { in: stageKeys },
            // A paused pair keeps its remaining days here and gets its deadline
            // back on resume (#1772); the re-engagement pool is not stuck.
            stageDeadlineRemainingDays: null,
            mentee: { reEngageAt: null },
          },
          select: {
            id: true,
            cohortId: true,
            mentorId: true,
            pipelineStatus: true,
            startDate: true,
            // Newest first; a run of no-op rows (#2264) longer than this is not a thing.
            statusChanges: {
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: { fromStatus: true, toStatus: true, createdAt: true },
            },
          },
          orderBy: { id: 'asc' },
          take: BATCH,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (relations.length === 0) break;
        cursor = relations[relations.length - 1].id;

        for (const relation of relations) {
          const plan = planStageDeadline(relation, rows, now);
          if (!plan) continue;
          const count = perStage.get(relation.pipelineStatus) ?? { set: 0, pastDue: 0 };
          count.set++;
          if (plan.pastDue) count.pastDue++;
          perStage.set(relation.pipelineStatus, count);
          total++;
          if (plan.pastDue) pastDue++;
          if (plan.enteredFrom === 'startDate') fromStartDate++;
          if (!apply) continue;

          const written = await prisma.mentorshipRelation.updateMany({
            where: { id: relation.id, stageDeadline: null, pipelineStatus: relation.pipelineStatus },
            data: {
              stageDeadline: plan.stageDeadline,
              deadlineReminderSentAt: plan.pastDue ? now : null,
            },
          });
          const escalateAfterDays = escalations.get(relation.pipelineStatus);
          if (written.count === 1 && plan.pastDue && escalateAfterDays) {
            await prisma.slaBreach.createMany({
              data: [
                {
                  orgId,
                  relationId: relation.id,
                  stageKey: relation.pipelineStatus,
                  dueAt: plan.stageDeadline,
                  level: 1,
                  snoozedUntil: new Date(now.getTime() + escalateAfterDays * DAY),
                },
              ],
              skipDuplicates: true,
            });
          }
        }
      }

      for (const [stage, c] of perStage) {
        console.log(`backfill-stage-deadlines (${mode}): org ${orgId} stage ${stage}: ${c.set} deadline(s), ${c.pastDue} already past`);
      }
    }
    console.log(
      `backfill-stage-deadlines (${mode}): ${total} relation(s) ${apply ? 'given' : 'would get'} a deadline, ` +
        `${pastDue} already past (reminder stamped, no mail), ${fromStartDate} dated from startDate (never moved).`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('backfill-stage-deadlines failed:', error);
  process.exitCode = 1;
});
