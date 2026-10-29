// Idempotent CompanyNeed -> Requisition conversion (#806), run on every deploy
// as backfill 0012 (prisma/backfills/registry.mjs, #1385/#1540).
//
// Since #1875 nothing writes CompanyNeed and nothing reads it for "open
// positions" — Requisition is the one source. This script is the expand/
// backfill half of retiring the table: it only ever ADDS a requisition (or
// re-points a converted twin, see findAdoptableTwin) and never touches a
// CompanyNeed row. Dropping the table is the separate contract step; it may
// only run once this prints `migrated=0` against production.
import { PrismaClient } from '@prisma/client';
import { findAdoptableTwin, mapCompanyNeedToRequisition } from './requisition-backfill-lib.mjs';

const prisma = new PrismaClient();
async function main() {
  const needs = await prisma.companyNeed.findMany({ include: { company: { select: { orgId: true } } }, orderBy: { id: 'asc' } });
  const liveNeedIds = new Set(needs.map((n) => n.id));
  const legacy = await prisma.requisition.findMany({
    where: { legacyCompanyNeedId: { not: null } },
    select: { id: true, companyId: true, title: true, description: true, legacyCompanyNeedId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const converted = new Set(legacy.map((r) => r.legacyCompanyNeedId));
  const claimed = new Set();
  let migrated = 0; let adopted = 0; let skipped = 0; let errors = 0;
  for (const need of needs) {
    try {
      if (converted.has(need.id)) { skipped++; continue; }
      const twin = findAdoptableTwin(need, legacy, liveNeedIds, claimed);
      if (twin) {
        // Guarded on the old pointer: a concurrent run that already moved it
        // updates nothing here, and the need is counted on its next pass.
        const res = await prisma.requisition.updateMany({
          where: { id: twin.id, legacyCompanyNeedId: twin.legacyCompanyNeedId },
          data: { legacyCompanyNeedId: need.id },
        });
        claimed.add(twin.id);
        if (res.count === 1) { adopted++; continue; }
      }
      await prisma.requisition.create({ data: mapCompanyNeedToRequisition(need) });
      migrated++;
    } catch (error) {
      errors++;
      console.error(`backfill-requisitions: need=${need.id} company=${need.companyId} error=${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  console.log(`backfill-requisitions: migrated=${migrated} adopted=${adopted} skipped=${skipped} errors=${errors}`);
  if (errors) process.exitCode = 1;
}
main().catch((error) => { console.error('backfill-requisitions failed:', error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
