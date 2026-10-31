// One OWNER CompanyMembership per existing COMPANY login (#1870,
// docs/company-team-seats.md), run on every deploy as backfill 0037
// (prisma/backfills/registry.mjs). Before seats existed every company login had
// the whole flat permission set — OWNER is exactly that. The code already reads
// a login without a row as OWNER (IMPLICIT_SEAT_ROLE), so this only makes the
// implicit row explicit; it never changes what anybody may do.
//
// Only ever ADDS rows (createMany + skipDuplicates on @@unique([companyId,
// userId])), so a second run reports created=0. Never touches a row a person
// set, and never a login without a company or an org.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { role: 'COMPANY', companyId: { not: null }, orgId: { not: null } },
    select: { id: true, companyId: true, orgId: true },
    orderBy: { id: 'asc' },
  });
  const existing = new Set(
    (await prisma.companyMembership.findMany({ select: { userId: true, companyId: true } })).map((m) => `${m.companyId}:${m.userId}`),
  );
  const rows = users
    .filter((u) => !existing.has(`${u.companyId}:${u.id}`))
    .map((u) => ({ orgId: u.orgId, companyId: u.companyId, userId: u.id, seatRole: 'OWNER' }));
  const res = rows.length ? await prisma.companyMembership.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
  console.log(`[company-memberships] created=${res.count} skipped=${users.length - res.count}`);
}

main()
  .catch((e) => {
    console.error('[company-memberships] FAILED', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
