// Grandfather every existing org into AI_PACKAGE, once (#1738).
//
// WHY THIS EXISTS. The admin AI tools — the AI rationale on the mentor-match
// ranking, the survey summary, the open-text insights on /admin/insights and
// the analytics narrative — were free until runAiGated started asking
// entitled(orgId, 'AI_PACKAGE') for every task whose registry entry says
// `audience: 'operator'` (src/lib/ai/tasks.ts). The pack is grant-only
// (GRANT_ONLY_FEATURES in src/lib/plans.ts), so no org has it from a plan, and
// the deploy that adds the gate would take the tools away from every tenant
// that used them yesterday. The maintainer's call is the one made for
// REPORT_EXPORT (#1740, 2026-10-06): the orgs that exist when the gate goes
// live keep what they had; the gate applies to orgs created after it.
//
// RUN-ONCE, NOT RUN-ALWAYS. "Every org gets a grant" on every deploy would
// grant every NEW org too, and the gate would never apply to anybody. So the
// first run stamps its grants with GRANDFATHER_NOTE, and any later run that
// finds a grant carrying that note does nothing. Idempotent within the run as
// well: createMany + skipDuplicates over @@unique([orgId, feature]) — an org
// that already holds the pack (the demo seed's grant, a hand-made grant) is
// skipped, never duplicated and never overwritten.
//
// Run: node prisma/backfill-ai-package-grandfather.mjs   [--dry-run]

import { PrismaClient } from '@prisma/client';

const FEATURE = 'AI_PACKAGE';
export const GRANDFATHER_NOTE = 'Grandfathered: the admin AI tools were free before the AI_PACKAGE gate (#1738).';

/** Should this run grant? Only when no earlier run left its mark. */
export function shouldGrandfather(markedGrants) {
  return markedGrants === 0;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();
  try {
    const marked = await prisma.orgEntitlement.count({ where: { feature: FEATURE, note: GRANDFATHER_NOTE } });
    if (!shouldGrandfather(marked)) {
      console.log(`backfill-ai-package-grandfather: already ran (${marked} grandfathered grant(s)) — nothing to do`);
      return;
    }
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    console.log(`backfill-ai-package-grandfather: ${orgs.length} existing org(s) keep the admin AI tools`);
    if (dryRun || orgs.length === 0) return;
    const result = await prisma.orgEntitlement.createMany({
      data: orgs.map((o) => ({ orgId: o.id, feature: FEATURE, note: GRANDFATHER_NOTE })),
      skipDuplicates: true,
    });
    console.log(`backfill-ai-package-grandfather: granted ${FEATURE} to ${result.count} org(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('backfill-ai-package-grandfather failed:', error);
    process.exit(1);
  });
}
