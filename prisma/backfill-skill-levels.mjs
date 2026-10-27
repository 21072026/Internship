// Copy the legacy self-assessment onto the canonical skill rows (#1822).
//
// `User.skillLevels` ({ "<typed skill>": 1..5 }) was the only home of a rating
// until `UserSkill.level` existed. A profile save mirrors it since #1822 part 1;
// this fills the rows of everyone who has not saved since.
//
// INSERT-ONLY, per row: a `UserSkill` gets a level only when it has none AND no
// `UserSkillLevelChange` history (planLegacyLevels in skill-taxonomy-lib.mjs) —
// a level set, confirmed or cleared since is never overwritten, and a re-run
// finds nothing to do. Each fill is a guarded update (`level: null` in the
// WHERE) plus one history row (SELF, changedById null = written by this
// backfill), so a racing profile save cannot produce two.
//
// Runs after 0030-skill-taxonomy (which creates the rows it fills). Never
// touches the JSON column. Dry-run by default; `--apply` writes.
import { PrismaClient } from '@prisma/client';
import { skillKey } from './skill-split.mjs';
import { makeResolver, planLegacyLevels } from './skill-taxonomy-lib.mjs';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const PAGE = 500;

async function main() {
  const orgs = await prisma.organization.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
  const totals = { people: 0, planned: 0, filled: 0 };
  for (const org of orgs) {
    const [skills, aliases] = await Promise.all([
      prisma.skill.findMany({ where: { orgId: org.id }, select: { id: true, key: true, status: true, mergedIntoId: true } }),
      prisma.skillAlias.findMany({ where: { orgId: org.id }, select: { key: true, skillId: true } }),
    ]);
    if (skills.length === 0) continue; // never seeded: 0030 has not run for it yet
    const resolve = makeResolver({ skills, aliases });
    let cursor = null;
    for (;;) {
      const users = await prisma.user.findMany({
        where: { orgId: org.id },
        select: { id: true, skillLevels: true },
        orderBy: { id: 'asc' },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (users.length === 0) break;
      cursor = users[users.length - 1].id;
      for (const user of users) {
        const levels = user.skillLevels;
        if (!levels || typeof levels !== 'object' || Object.keys(levels).length === 0) continue;
        const rows = await prisma.userSkill.findMany({
          where: { userId: user.id },
          select: { id: true, skillId: true, level: true, _count: { select: { levelChanges: true } } },
        });
        if (rows.length === 0) continue;
        const held = new Map(rows.map((r) => [r.skillId, { id: r.id, level: r.level, hasHistory: r._count.levelChanges > 0 }]));
        const plan = planLegacyLevels({ levels, resolve, fold: skillKey, held });
        if (plan.length === 0) continue;
        totals.people++;
        totals.planned += plan.length;
        if (!APPLY) continue;
        const now = new Date();
        for (const { userSkillId, toLevel } of plan) {
          const filled = await prisma.$transaction(async (tx) => {
            const moved = await tx.userSkill.updateMany({
              where: { id: userSkillId, level: null },
              data: { level: toLevel, levelSource: 'SELF', levelUpdatedAt: now },
            });
            if (moved.count !== 1) return 0;
            await tx.userSkillLevelChange.create({
              data: { userSkillId, fromLevel: null, toLevel, source: 'SELF', changedById: null },
            });
            return 1;
          });
          totals.filled += filled;
        }
      }
    }
  }
  console.log(
    `[skill-levels] ${APPLY ? 'applied' : 'dry-run'}: ${totals.people} people, ${totals.planned} level(s) to copy` +
      (APPLY ? `, ${totals.filled} written` : ' (pass --apply to write)'),
  );
}

main()
  .catch((err) => {
    console.error('[skill-levels] FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
