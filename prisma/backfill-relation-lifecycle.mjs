// Backfill MentorshipRelation.lifecycleState so it agrees with `status` (#1768).
//
// The column existed before #1768 as "how did it END" (#1801) and was NULL on
// every other row. It now carries every state (src/lib/relationLifecycle.ts),
// and the SQL filters that tell a paused pair from a live one — the billing
// meter first — read it directly. This is the backfill half of expand →
// backfill → contract (#2298): the column stays nullable with a DB default of
// 'ACTIVE', and this script fills it.
//
// The mapping is effectiveLifecycleState() in src/lib/relationLifecycle.ts,
// written as two updates, so a row reads the same before and after this runs
// and no number anywhere moves:
//
//   · status ACTIVE    and the column not ACTIVE/PAUSED → 'ACTIVE'
//                      (NULL, or a stale terminal value left by a reopen that
//                      set `status` alone)
//   · status COMPLETED and the column NULL/ACTIVE/PAUSED → 'COMPLETED'
//                      (NULL, or the 'ACTIVE' default on a row created already
//                      COMPLETED — imports, seeds). An ENDED_* value is kept:
//                      it is the honest record of how that pairing ended.
//
// Idempotent by construction — each update only matches rows that disagree
// with the mapping, so a second run touches nothing. Safe to leave wired into
// deploy-prod.sh forever; it also repairs any row a not-yet-migrated writer
// leaves disagreeing.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const LIVE = ['ACTIVE', 'PAUSED'];

async function main() {
  // Prisma's `notIn` drops NULLs (SQL three-valued logic), so NULL is its own arm.
  const live = await prisma.mentorshipRelation.updateMany({
    where: { status: 'ACTIVE', OR: [{ lifecycleState: null }, { lifecycleState: { notIn: LIVE } }] },
    data: { lifecycleState: 'ACTIVE' },
  });
  const closed = await prisma.mentorshipRelation.updateMany({
    where: { status: 'COMPLETED', OR: [{ lifecycleState: null }, { lifecycleState: { in: LIVE } }] },
    data: { lifecycleState: 'COMPLETED', pausedAt: null },
  });

  console.log(
    live.count + closed.count === 0
      ? 'backfill-relation-lifecycle: nothing to do.'
      : `backfill-relation-lifecycle: ${live.count} live relation(s) → ACTIVE, ${closed.count} closed relation(s) → COMPLETED.`,
  );
}

main()
  .catch((e) => {
    console.error('backfill-relation-lifecycle failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
