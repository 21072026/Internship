// Idempotent backfill for the admin tier (#1567): every ADMIN account that has
// no `adminLevel` yet gets ORG_ADMIN — everything inside its own tenant, which
// is exactly what `role = 'ADMIN'` has always meant. A data normaliser, not a
// schema step: `db push` adds the column as NULL.
//
// What it deliberately does NOT do:
//   - touch a tier that is already set (an operator may have narrowed an admin
//     to PROGRAM_ADMIN or OBSERVER — a re-run must never widen it back);
//   - touch a non-ADMIN row (a tier on a MENTOR would mean nothing, and the
//     authorization layer ignores it for any role but ADMIN anyway);
//   - grant a platform tier. There is none in AdminLevel: the instance operator
//     is `User.isSuperAdmin` (src/lib/superAdmin.ts), which prisma/seed.mjs
//     already sets on the first admin.
//
// Runs on deploy next to the other backfills. Safe to run repeatedly.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const res = await prisma.user.updateMany({
    where: { role: 'ADMIN', adminLevel: null },
    data: { adminLevel: 'ORG_ADMIN' },
  });
  console.log(`backfill-admin-level: ${res.count} ADMIN row(s) set to ORG_ADMIN.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
