// Fill WeeklyReportReminder.recipientId for rows written before #2287.
//
// WHY THE COLUMN EXISTS
//   The weekly-report reminder is capped at one per week, and the claim that
//   enforces it is `@@unique([relationId, weekStart])` — keyed by the RELATION.
//   That is the right key for the race (two overlapping ticks, one row), and
//   the wrong key for the promise: what the product owes is one reminder per
//   PERSON per week, and a relation-keyed row cannot answer "has this human
//   already been reminded this week?" at all. So the sweep now also records who
//   it wrote to, and reads that back before claiming.
//
// WHY IT IS A SEPARATE BACKFILL AND NOT A DEFAULT
//   `db push` REFUSES a new required column whose default is client-side or
//   absent on a table that already has rows (#2298) — additive is not the same
//   as appliable, and `--accept-data-loss` does not cover it. So the column
//   ships nullable, and this fills the history.
//
// WHAT IT DOES NOT DO
//   It does not add `@@unique([recipientId, weekStart])`, and it does not
//   delete the duplicate rows that unique would reject. Both are the CONTRACT
//   step, and both are gated on this backfill reading clean on prod AND the
//   shared preview first — the same sequencing docs/one-active-mentor.md uses
//   for its own DB backstop (#2286). Deploys run `db push` BEFORE the backfills,
//   so an index added in the same change would be built against rows that are
//   still NULL, and against precisely the duplicates the issue is about.
//
//   It DOES report those duplicates, so the contract step has a number to wait
//   on: a line per (recipient, week) that holds more than one row.
//
// Idempotent: it only ever fills rows where recipientId IS NULL, so a second
// run touches nothing. Safe to leave wired into deploy-prod.sh forever.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const pending = await prisma.weeklyReportReminder.findMany({
    where: { recipientId: null },
    select: { id: true, relation: { select: { menteeId: true } } },
  });

  let filled = 0;
  let orphaned = 0;
  for (const row of pending) {
    const menteeId = row.relation?.menteeId;
    if (!menteeId) {
      // The relation is gone (the FK cascades, so this should be unreachable);
      // leaving the row NULL is correct — inventing a recipient would be worse.
      orphaned += 1;
      continue;
    }
    await prisma.weeklyReportReminder.update({ where: { id: row.id }, data: { recipientId: menteeId } });
    filled += 1;
  }

  // The integrity report the contract step waits on. Counted over ALL rows, not
  // just the ones filled here, because a duplicate written before this change
  // is exactly the case that would fail the future unique index.
  // Counted in JS rather than with a `having` clause on purpose: `having` has to
  // agree with the aggregate actually selected, and getting that pairing wrong
  // throws at RUNTIME — on the production box, inside a deploy step whose
  // failure is swallowed by `|| true`. The report would then be silently gone,
  // which is the one thing this report exists not to be. The table is small
  // (one row per mentee per week).
  const groups = (
    await prisma.weeklyReportReminder.groupBy({
      by: ['recipientId', 'weekStart'],
      where: { recipientId: { not: null } },
      _count: { _all: true },
    })
  ).filter((group) => group._count._all > 1);

  console.log(
    `weekly-report-reminder recipient backfill: ${filled} filled, ${orphaned} left NULL (no relation), ` +
      `${groups.length} (recipient, week) pair(s) hold more than one row`
  );
  if (groups.length > 0) {
    console.log(
      'weekly-report-reminder: the @@unique([recipientId, weekStart]) contract step (#2287) is NOT clear to apply yet — ' +
        'those pairs must be collapsed first, or the index creation fails the deploy.'
    );
  }
}

main()
  .catch((error) => {
    console.error('weekly-report-reminder recipient backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
