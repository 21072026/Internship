// Stamp AuditLog.orgId on the rows written before the column existed (#2012).
// Node 20 ESM, no TS imports — the server runs it inside the image.
//
// WHY IT MUST RUN BEFORE backfill-organization.mjs
//   Exactly the argument prisma/backfill-activity-log-org.mjs makes: that
//   script fills EVERY nullable orgId column with the default org. Run first,
//   it would hand a MARKETING admin's impersonation starts and password resets
//   to the INTERNSHIP tenant's SIEM drain. So this pass attributes what it can
//   — the actor's org, then the affected user's org — and only the remainder
//   (system rows such as `offer.expire`, whose actor is the literal 'system')
//   falls to the default org there.
//
// Idempotent: every statement touches `orgId IS NULL` rows only, and a user
// without an org is skipped (NULL → NULL is not an update). Raw SQL rather
// than updateMany for the same reason the ActivityLog script gives: a
// bookkeeping pass should never look like an edit of an audit row.
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** The statements, in rule order: the actor's org wins over the target's. */
export function backfillStatements() {
  return [
    {
      label: 'from actor',
      sql:
        'UPDATE `AuditLog` a JOIN `User` u ON u.`id` = a.`actorId` ' +
        'SET a.`orgId` = u.`orgId` WHERE a.`orgId` IS NULL AND u.`orgId` IS NOT NULL',
    },
    {
      label: 'from target user',
      sql:
        'UPDATE `AuditLog` a JOIN `User` u ON u.`id` = a.`targetId` ' +
        'SET a.`orgId` = u.`orgId` WHERE a.`orgId` IS NULL AND u.`orgId` IS NOT NULL',
    },
  ];
}

async function main() {
  const prisma = new PrismaClient();
  try {
    let total = 0;
    for (const { label, sql } of backfillStatements()) {
      const n = await prisma.$executeRawUnsafe(sql);
      total += n;
      if (n) console.log(`backfill-audit-log-org: ${n} row(s) ${label}`);
    }
    const [{ n: left }] = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS n FROM `AuditLog` WHERE `orgId` IS NULL',
    );
    console.log(
      `backfill-audit-log-org: ${total} row(s) attributed; ${Number(left)} system row(s) left for ` +
        'backfill-organization.mjs (default org).',
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
