// Grandfather every existing org into REPORT_EXPORT, once (#1740).
//
// WHY THIS EXISTS. Admin exports (candidates CSV/XLSX, the analytics
// workbooks, the contributor-terms report) were free until the export route
// started asking entitled(orgId, 'REPORT_EXPORT'). Hardly any org has that
// from a plan yet, so the deploy that adds the gate would take a feature away
// from everyone who used it yesterday. The maintainer's call (2026-10-06): the
// orgs that exist when the gate goes live keep exporting; the gate applies to
// orgs created after it.
//
// RUN-ONCE, NOT RUN-ALWAYS. "Every org gets a grant" on every deploy would
// grant every NEW org too, and the gate would never apply to anybody. So the
// first run stamps its grants with GRANDFATHER_NOTE, and any later run that
// finds a grant carrying that note does nothing. Idempotent within the run as
// well: createMany + skipDuplicates over @@unique([orgId, feature]).
//
// Run: node prisma/backfill-report-export-grandfather.mjs   [--dry-run]

import { PrismaClient } from '@prisma/client';

const FEATURE = 'REPORT_EXPORT';
export const GRANDFATHER_NOTE = 'Grandfathered: exports were free before the REPORT_EXPORT gate (#1740).';

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
      console.log(`backfill-report-export-grandfather: already ran (${marked} grandfathered grant(s)) — nothing to do`);
      return;
    }
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    console.log(`backfill-report-export-grandfather: ${orgs.length} existing org(s) keep their exports`);
    if (dryRun || orgs.length === 0) return;
    const result = await prisma.orgEntitlement.createMany({
      data: orgs.map((o) => ({ orgId: o.id, feature: FEATURE, note: GRANDFATHER_NOTE })),
      skipDuplicates: true,
    });
    console.log(`backfill-report-export-grandfather: granted ${FEATURE} to ${result.count} org(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('backfill-report-export-grandfather failed:', error);
    process.exit(1);
  });
}
