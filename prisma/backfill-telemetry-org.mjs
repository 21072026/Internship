// Stamp PageView.orgId and EmailLog.orgId on the rows written before the
// columns existed (#1556). Node 20 ESM, no TS imports — the server runs it
// inside the image.
//
// WHY IT MUST RUN BEFORE backfill-organization.mjs
//   That script fills EVERY nullable orgId column with the default org. Run
//   first, it would hand a MARKETING tenant's page views and mail ledger to the
//   INTERNSHIP default org. This pass attributes what it can; only the
//   remainder falls to the default org there.
//
// THE RULES
//   PageView — the viewer's org: `userId` is required on the row, so every
//     view of a user who has an org is attributed.
//   EmailLog — the recipient's org, by address, and ONLY when the address
//     names accounts in exactly one org. Since #2605 one mailbox can be a user
//     in two worlds, and a legacy row cannot say which of them a mail was for;
//     guessing would put one world's mail in the other's ledger. Such rows (and
//     mail to an address with no account) are left to the default-org fill —
//     the super-admin mail view still reads them by address (docs/worlds.md),
//     so nothing becomes visible to a tenant admin through this.
//
// Idempotent: every statement touches `orgId IS NULL` rows only. Raw SQL for
// the same reason the sibling backfills give: a bookkeeping pass should never
// look like an edit.
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function backfillStatements() {
  return [
    {
      table: 'PageView',
      label: 'from viewer',
      sql:
        'UPDATE `PageView` p JOIN `User` u ON u.`id` = p.`userId` ' +
        'SET p.`orgId` = u.`orgId` WHERE p.`orgId` IS NULL AND u.`orgId` IS NOT NULL',
    },
    {
      table: 'EmailLog',
      label: 'from the one org holding the recipient address',
      sql:
        'UPDATE `EmailLog` e JOIN (' +
        'SELECT `email`, MIN(`orgId`) AS `orgId` FROM `User` WHERE `orgId` IS NOT NULL ' +
        'GROUP BY `email` HAVING COUNT(DISTINCT `orgId`) = 1' +
        ') u ON u.`email` = e.`to` SET e.`orgId` = u.`orgId` WHERE e.`orgId` IS NULL',
    },
  ];
}

async function main() {
  const prisma = new PrismaClient();
  try {
    for (const { table, label, sql } of backfillStatements()) {
      const n = await prisma.$executeRawUnsafe(sql);
      const [{ n: left }] = await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`orgId\` IS NULL`);
      console.log(
        `backfill-telemetry-org: ${table}: ${n} row(s) ${label}; ${Number(left)} left for backfill-organization.mjs (default org).`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('backfill-telemetry-org failed:', e);
    process.exit(1);
  });
}
