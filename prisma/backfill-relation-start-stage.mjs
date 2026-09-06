// Repair relations parked on a stage key their own tenant does not have (#1634).
//
// Until this ship, every create path let the schema default
// (`pipelineStatus String @default("APPLICATION_100")`) apply. That is the right
// value for a tenant on the built-in catalogue and a dead end for one that
// customised its pipeline: the key exists in no `PipelineStage` row of theirs,
// so the relation renders in no board column, counts in no funnel row and has no
// stage select to move it out of. The mentee is invisible.
//
// This walks the orgs that HAVE custom stages, finds relations sitting on a key
// outside that org's set, and moves each one to the set's first on-path stage —
// the same value the fixed create paths now write. Every move writes a
// `StatusChange` row, so the correction shows up in the relation's own history
// instead of a value silently changing under an admin.
//
// Scope, deliberately narrow:
//   * only orgs with at least one PipelineStage row. An org on the defaults has
//     no "unresolvable" concept to repair, and its legacy keys (an old import,
//     a hand-edited row) are none of this script's business.
//   * off-path stages can never be a destination — `isOffPath` rows are skipped
//     when picking the target, so a tenant that ordered "Withdrew" first still
//     lands on its first real stage.
//   * an org whose stages are ALL off-path has no valid destination; those
//     relations are reported and left alone rather than guessed at.
//
// Idempotent by construction: after a move the key is in the org's set, so the
// next run's filter does not match it. Safe to leave wired into deploy-prod.sh.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const orgIds = (
    await prisma.pipelineStage.findMany({ select: { orgId: true }, distinct: ['orgId'] })
  ).map((r) => r.orgId);

  if (orgIds.length === 0) {
    console.log('backfill-relation-start-stage: no org has custom stages, nothing to do.');
    return;
  }

  let moved = 0;
  let skipped = 0;

  for (const orgId of orgIds) {
    const stages = await prisma.pipelineStage.findMany({
      where: { orgId },
      orderBy: { order: 'asc' },
      select: { key: true, isOffPath: true },
    });
    const known = new Set(stages.map((s) => s.key));
    const target = stages.find((s) => !s.isOffPath)?.key;
    if (!target) {
      console.warn(
        `backfill-relation-start-stage: org ${orgId} has no on-path stage — skipping its relations.`,
      );
      continue;
    }

    const stranded = await prisma.mentorshipRelation.findMany({
      where: { orgId, pipelineStatus: { notIn: [...known] } },
      select: { id: true, mentorId: true, pipelineStatus: true },
    });
    if (stranded.length === 0) continue;

    // The move needs an actor for the audit row. The org's own oldest admin is
    // the honest attribution; a tenant without one (possible mid-provisioning)
    // falls back to the relation's mentor so the history is still written —
    // never dropped, because an unexplained stage change is worse than one
    // attributed to the nearest responsible account.
    const admin = await prisma.user.findFirst({
      where: { orgId, role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    for (const rel of stranded) {
      const changedById = admin?.id ?? rel.mentorId;
      if (!changedById) {
        skipped++;
        continue;
      }
      await prisma.$transaction([
        prisma.mentorshipRelation.update({
          where: { id: rel.id },
          data: { pipelineStatus: target },
        }),
        prisma.statusChange.create({
          data: {
            relationId: rel.id,
            fromStatus: rel.pipelineStatus,
            toStatus: target,
            changedById,
          },
        }),
      ]);
      moved++;
    }
  }

  console.log(
    moved === 0 && skipped === 0
      ? 'backfill-relation-start-stage: nothing to do.'
      : `backfill-relation-start-stage: moved ${moved} relation(s) onto their org's first on-path stage` +
          (skipped > 0 ? `; skipped ${skipped} with no attributable actor.` : '.'),
  );
}

main()
  .catch((e) => {
    console.error('backfill-relation-start-stage failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
