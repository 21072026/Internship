// Manual, idempotent CompanyNeed -> Requisition compatibility backfill (#806).
// Intentionally not wired into deployment.
import { PrismaClient } from '@prisma/client';
import { mapCompanyNeedToRequisition } from './requisition-backfill-lib.mjs';

const prisma = new PrismaClient();
async function main() {
  const needs = await prisma.companyNeed.findMany({ include: { company: { select: { orgId: true } } }, orderBy: { id: 'asc' } });
  let migrated = 0; let skipped = 0; let errors = 0;
  for (const need of needs) {
    try {
      const exists = await prisma.requisition.findUnique({ where: { legacyCompanyNeedId: need.id }, select: { id: true } });
      if (exists) { skipped++; continue; }
      await prisma.requisition.create({ data: mapCompanyNeedToRequisition(need) });
      migrated++;
    } catch (error) {
      errors++;
      console.error(`backfill-requisitions: need=${need.id} company=${need.companyId} error=${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  console.log(`backfill-requisitions: migrated=${migrated} skipped=${skipped} errors=${errors}`);
  if (errors) process.exitCode = 1;
}
main().catch((error) => { console.error('backfill-requisitions failed:', error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
