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
// The work itself is prisma/stage-deadline-fill.mjs, which the admin's SLA
// save also runs for its own org (#3203).
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
import { fillOrgStageDeadlines } from './stage-deadline-fill.mjs';

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
      const r = await fillOrgStageDeadlines(prisma, orgId, { apply, now });
      total += r.total;
      pastDue += r.pastDue;
      fromStartDate += r.fromStartDate;
      for (const [stage, c] of r.perStage) {
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
