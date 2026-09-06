// Repair relations left on the SCHEMA DEFAULT in a tenant that does not have
// that key (#1634).
//
// Until this ship, every create path let the schema default
// (`pipelineStatus String @default("APPLICATION_100")`) apply. That is the right
// value for a tenant on the built-in catalogue and a dead end for one that
// customised its pipeline: the key exists in no `PipelineStage` row of theirs,
// so the relation renders in no board column, counts in no funnel row and has no
// stage select to move it out of. The mentee is invisible.
//
// Scope — read this before widening it. The temptation is to repair every
// relation whose key is outside its org's current set; that is CATASTROPHICALLY
// wrong. `PUT /api/admin/organizations/[id]/pipeline-stages` replaces the stage
// set by deleting every row and recreating it, and it remaps no relation, so a
// tenant that renames one stage — or that customises its pipeline after months
// on the built-in catalogue — has its ENTIRE pipeline outside the current set
// for a moment. A `notIn` filter would sweep all of it, unattended, on the next
// prod deploy: someone at EMPLOYED_700 dragged back to stage 1, a COMPLETED
// relation reading as a fresh lead, and the dormancy sweep then mailing an
// already-placed mentee "hâlâ ilgileniyor musun?".
//
// So this only touches rows that can ONLY have come from the bug:
//   * `pipelineStatus` is exactly the schema default `APPLICATION_100` — the
//     value a create wrote by omission, never one an admin picked here,
//   * and that key is absent from the org's own set,
//   * and the org HAS custom stages (an org on the defaults has no
//     "unresolvable" concept to repair),
//   * and the relation is still ACTIVE,
//   * and it has never been moved: zero `StatusChange` rows. A relation that
//     was ever placed deliberately is not this bug's doing, whatever it now
//     reads, and must not be dragged back to stage 1.
//
// The destination mirrors `startStageKey()` in src/lib/pipeline.ts exactly —
// first on-path stage by order, falling back to the first stage by order for a
// set that is somehow all off-path — so the backfill and the create paths can
// never disagree about where a relation starts.
//
// Every move writes a `StatusChange`, so the correction shows up in the
// relation's own history instead of a value silently changing under an admin.
// (That row is also what makes this idempotent twice over: after a move the key
// is in the org's set AND the relation now has a status-change row.)
//
// Dry run by default — it prints what it would move and writes nothing. Pass
// `--apply` (deploy-prod.sh does) to perform the moves.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The schema default, and the only value this script will move a relation off.
const SCHEMA_DEFAULT_STAGE = 'APPLICATION_100';

async function main() {
  const apply = process.argv.includes('--apply') || process.env.BACKFILL_APPLY === '1';

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
    // The org has the canonical key after all — nothing here is stranded.
    if (stages.some((s) => s.key === SCHEMA_DEFAULT_STAGE)) continue;

    const target = (stages.find((s) => !s.isOffPath) ?? stages[0])?.key;
    if (!target) continue; // impossible (distinct came from these rows), cheap to hold.

    const stranded = await prisma.mentorshipRelation.findMany({
      where: {
        orgId,
        pipelineStatus: SCHEMA_DEFAULT_STAGE,
        status: 'ACTIVE',
        statusChanges: { none: {} },
      },
      select: { id: true, mentorId: true, pipelineStatus: true },
    });
    if (stranded.length === 0) continue;

    console.log(
      `backfill-relation-start-stage: org ${orgId} — ${stranded.length} relation(s) on ` +
        `${SCHEMA_DEFAULT_STAGE}, which is not in its stage set; target "${target}"` +
        (apply ? '.' : ' (dry run, nothing written).'),
    );
    if (!apply) {
      skipped += stranded.length;
      continue;
    }

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

  if (!apply) {
    console.log(
      skipped === 0
        ? 'backfill-relation-start-stage: nothing to do.'
        : `backfill-relation-start-stage: DRY RUN — ${skipped} relation(s) would move. Re-run with --apply to write.`,
    );
    return;
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
