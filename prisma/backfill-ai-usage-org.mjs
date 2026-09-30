// Stamp AiUsage.orgId on the rows written before the column existed (per-org
// AI quota). Node 20 ESM, no TS imports — the server runs it inside the image.
//
// The monthly AI quota is a tenant setting, and src/lib/aiGate.ts now counts a
// tenant's usage against it by `orgId`. A legacy row is attributed to:
//
//   1. the org of the user who made the call (`userId`);
//   2. else the org of the company it was made for (`companyId`);
//   3. else NULL here, which backfill-organization.mjs then assigns to the
//      default org — the same owner orgWhere() already gives a NULL row.
//
// Must run BEFORE backfill-organization.mjs for the same reason as
// backfill-activity-log-org.mjs: run after it, every row would already be the
// default org's, and a MARKETING tenant's calls would sit in the INTERNSHIP
// tenant's month. Only the current month matters to the quota, so a wrong
// attribution would heal itself on the 1st — but the rows are also the
// metering history, and they should say whose calls they were.
//
// Idempotent: every statement touches `orgId IS NULL` rows only. Raw SQL, like
// the other org backfills.
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Pure mirror of the rule above, for tests. */
export function pickAiUsageOrg({ userOrgId, companyOrgId }) {
  return userOrgId || companyOrgId || null;
}

/** The statements, in rule order — the user pass first, so it wins. */
export function backfillStatements() {
  return [
    {
      label: 'from user',
      sql:
        'UPDATE `AiUsage` a JOIN `User` u ON u.`id` = a.`userId` ' +
        'SET a.`orgId` = u.`orgId` WHERE a.`orgId` IS NULL AND u.`orgId` IS NOT NULL',
    },
    {
      label: 'from company',
      sql:
        'UPDATE `AiUsage` a JOIN `Company` c ON c.`id` = a.`companyId` ' +
        'SET a.`orgId` = c.`orgId` WHERE a.`orgId` IS NULL AND c.`orgId` IS NOT NULL',
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
      if (n) console.log(`backfill-ai-usage-org: ${n} row(s) ${label}`);
    }
    const [{ n: left }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM `AiUsage` WHERE `orgId` IS NULL');
    console.log(
      `backfill-ai-usage-org: ${total} row(s) attributed; ${Number(left)} row(s) left for ` +
        'backfill-organization.mjs (default org).',
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('backfill-ai-usage-org failed:', e);
    process.exit(1);
  });
}
