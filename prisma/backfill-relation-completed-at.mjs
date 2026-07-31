// Backfill MentorshipRelation.completedAt for relations that were already
// COMPLETED before the column existed (#854).
//
// Why this is needed: the post-mentorship CV/document access window is anchored
// on `completedAt`, and `completedAt: { gte: cutoff }` never matches NULL. So
// without this, every historical COMPLETED relation would lose mentor/company
// access the moment the feature ships — an abrupt revocation nobody asked for,
// and one a mentor mid-reference would experience as a bug.
//
// Stamping them with "now" starts each legacy relation's window at the upgrade
// instead. It is generous by at most one window length, and it converges: six
// months after this runs, every one of those relations has aged out normally.
//
// Idempotent by construction — it only ever fills NULLs on COMPLETED rows, so a
// second run touches nothing. Safe to leave wired into deploy-prod.sh forever.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  const { count } = await prisma.mentorshipRelation.updateMany({
    where: { status: 'COMPLETED', completedAt: null },
    data: { completedAt: now },
  });

  console.log(
    count === 0
      ? 'backfill-relation-completed-at: nothing to do.'
      : `backfill-relation-completed-at: stamped ${count} completed relation(s) at ${now.toISOString()}.`,
  );
}

main()
  .catch((e) => {
    console.error('backfill-relation-completed-at failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
