import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

try {
  const interests = await prisma.companyInterest.findMany({
    where: { scopeKey: null },
    select: { id: true, companyId: true, menteeId: true, requisitionId: true },
  });

  for (const interest of interests) {
    const scopeKey = interest.requisitionId
      ? `requisition:${interest.requisitionId}:${interest.menteeId}`
      : `legacy:${interest.companyId}:${interest.menteeId}`;
    await prisma.companyInterest.update({ where: { id: interest.id }, data: { scopeKey } });
  }

  console.log(`CompanyInterest scope backfill complete (${interests.length} row(s))`);
} finally {
  await prisma.$disconnect();
}
