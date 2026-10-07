// Idempotent: one Application per existing CompanyInterest that names a
// requisition (#1828). Run on every deploy (infra/deploy-prod.sh) and by hand
// with `npm run backfill:applications`; a second run reports created=0.
//
// Only ever ADDS rows. CompanyInterest is never read for anything but its
// values and never written: re-keying or deleting it is a drop-and-recreate
// under `db push` and is out of scope by design. An interest already mirrored
// (the DB's @@unique([requisitionId, menteeId]) says so) is skipped, so two
// deploys racing each other cannot double-create either.
import { PrismaClient, Prisma } from '@prisma/client';
import { interestToApplication } from './applications-backfill-lib.mjs';

const prisma = new PrismaClient();

async function main() {
  const interests = await prisma.companyInterest.findMany({
    where: { requisitionId: { not: null } },
    select: {
      id: true, companyId: true, menteeId: true, requisitionId: true, status: true, note: true,
      createdAt: true, updatedAt: true,
      requisition: { select: { orgId: true, companyId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  let created = 0;
  let skipped = 0;
  let errors = 0;
  for (const interest of interests) {
    const seed = interestToApplication(interest);
    if (!seed || !interest.requisition) { skipped++; continue; }
    if (interest.requisition.companyId !== interest.companyId) {
      // Cannot happen through the shortlist route (it checks the requisition
      // belongs to the company); if it did, guessing which company is right
      // would be worse than leaving the row for a human.
      errors++;
      console.error(`backfill-applications: interest=${interest.id} companyId=${interest.companyId} differs from requisition companyId=${interest.requisition.companyId}; skipped`);
      continue;
    }
    const exists = await prisma.application.findUnique({
      where: { requisitionId_menteeId: { requisitionId: seed.requisitionId, menteeId: seed.menteeId } },
      select: { id: true },
    });
    if (exists) { skipped++; continue; }
    try {
      await prisma.application.create({
        data: {
          orgId: interest.requisition.orgId,
          ...seed,
          createdAt: interest.createdAt,
          decidedAt: seed.status === 'ACTIVE' ? null : interest.updatedAt,
          events: { create: { fromStage: null, toStage: seed.stage, actorId: null, note: `backfilled from CompanyInterest ${interest.id}` } },
        },
      });
      created++;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') { skipped++; continue; }
      errors++;
      console.error(`backfill-applications: interest=${interest.id} error=${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  console.log(`backfill-applications: created=${created} skipped=${skipped} errors=${errors}`);
  if (errors) process.exitCode = 1;
}

main()
  .catch((error) => { console.error('backfill-applications failed:', error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
