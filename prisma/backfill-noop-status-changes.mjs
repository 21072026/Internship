// Delete the stage-history rows that record no movement (#934).
//
// A `StatusChange` whose `fromStatus` equals its `toStatus` says "this person
// moved from stage X to stage X". Nobody moved. Until #934 the write paths let
// those rows in — the seeded demo set produced one for every mentee still on
// the first stage, and `POST /api/status-changes` accepted whatever the client
// sent — and the UI has since learned to hide them (the relation detail API and
// the timeline filter with `isStageTransition`). Hiding them was never enough:
// the numbers are computed from the TABLE, not from the list the UI renders.
//
//   * `stageEnteredAt()` (src/lib/stageClock.ts) takes the newest StatusChange
//     whatever it says, so a no-op row RESTARTS the "days in stage" clock — the
//     board chip, the aging report and the mentor list all read younger than
//     the truth, and an overdue relation can quietly stop being overdue.
//   * `computeStageAging()` (src/lib/stageAging.ts) reads the row as "left
//     stage X, entered stage X" and counts two visits where there was one, with
//     a near-zero dwell dragging that stage's average and median down.
//   * The mentor analytics "stage moves" figure and the activity report's
//     status-change count (src/lib/activityReport.ts) count rows directly.
//
// THE PREDICATE — the whole of it, and deliberately nothing more:
//
//     StatusChange.fromStatus === StatusChange.toStatus
//
// Compared as strings, because `pipelineStatus` is a free-form String now so a
// tenant may have custom stage keys (#747) — no enum, no canonical key list, no
// normalisation (no trim, no case folding): "review" and "Review " are two
// different keys as far as every other part of this codebase is concerned, and
// a cleanup script is not the place to start disagreeing with it.
//
// Nothing else is touched. Not old rows, not rows whose stage key no longer
// exists in the org's set, not duplicate consecutive moves, not rows with a
// missing `reasonCode`. A row that records a real move is evidence, however
// odd it looks.
//
// Idempotent: re-running deletes nothing because the first run left no matching
// row behind, and no write path can create another one.
//
// Dry run by default — it prints what it would delete and writes nothing. Pass
// `--apply` (deploy-prod.sh does) to delete.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Prisma cannot compare two columns of the same row in a `where`, and raw SQL
// here would have to be written twice (MySQL in production, whatever a
// contributor runs locally). Scanning in pages and matching in JS costs one
// query per page and keeps the predicate readable in exactly one place.
const PAGE = 1000;

async function main() {
  const apply = process.argv.includes('--apply') || process.env.BACKFILL_APPLY === '1';

  let cursor = null;
  let scanned = 0;
  let deleted = 0;
  const doomed = [];

  // The whole table is READ first and deleted afterwards, deliberately: the
  // scan pages on `cursor: { id: … }`, and the cursor row is by definition the
  // last row of the page — which may itself be a no-op row. Deleting as we go
  // would therefore sometimes delete the very row the next page is anchored on
  // and cut the scan short, silently leaving no-op rows behind. Only the
  // matching rows are held, which is a small subset by construction.
  for (;;) {
    const page = await prisma.statusChange.findMany({
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true, relationId: true, fromStatus: true, toStatus: true },
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1].id;

    for (const row of page) {
      if (row.fromStatus === row.toStatus) doomed.push(row);
    }
  }

  if (doomed.length === 0) {
    console.log(`backfill-noop-status-changes: scanned ${scanned} row(s), no no-op history to remove.`);
    return;
  }

  if (!apply) {
    const sample = doomed.slice(0, 10);
    for (const row of sample) {
      console.log(
        `backfill-noop-status-changes: relation ${row.relationId} — "${row.fromStatus}" → "${row.toStatus}" (row ${row.id})`,
      );
    }
    if (doomed.length > sample.length) {
      console.log(`backfill-noop-status-changes: … and ${doomed.length - sample.length} more.`);
    }
    console.log(
      `backfill-noop-status-changes: DRY RUN — ${doomed.length} of ${scanned} row(s) would be deleted. ` +
        'Re-run with --apply to write.',
    );
    return;
  }

  // Chunked so the `IN (…)` list never grows past what MySQL is happy to parse.
  for (let i = 0; i < doomed.length; i += PAGE) {
    const { count } = await prisma.statusChange.deleteMany({
      where: { id: { in: doomed.slice(i, i + PAGE).map((r) => r.id) } },
    });
    deleted += count;
  }

  console.log(
    `backfill-noop-status-changes: deleted ${deleted} no-op stage-history row(s) out of ${scanned} scanned.`,
  );
}

main()
  .catch((e) => {
    console.error('backfill-noop-status-changes failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
