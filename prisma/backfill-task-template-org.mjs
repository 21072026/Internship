// Stamp ProjectTaskTemplate.orgId on the rows written before the column
// existed (cross-world isolation). Node 20 ESM, no TS imports.
//
// The shared goal pool (`projectId: null`) used to be ONE pool offered to every
// organization — a MARKETING admin saw the internship starter goals and could
// reword them for everybody. Each template now belongs to one org's pool:
//
//   1. a project's own template → the project's org;
//   2. a shared template an admin wrote → that author's org;
//   3. anything left (the seeded internship starter set, authorless rows) →
//      NULL here, which backfill-organization.mjs then assigns to the default
//      (INTERNSHIP) org — the product that starter set was written for.
//
// Must run BEFORE backfill-organization.mjs for the same reason as
// backfill-activity-log-org.mjs: run after it, every row would already be the
// default org's and a MARKETING admin's own shared goals would leave their pool.
//
// Idempotent: only `orgId IS NULL` rows are touched.
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Pure mirror of the rule above, for the unit test. */
export function pickTemplateOrg({ projectOrgId, authorOrgId }) {
  return projectOrgId || authorOrgId || null;
}

export function backfillStatements() {
  return [
    {
      label: 'from project',
      sql:
        'UPDATE `ProjectTaskTemplate` t JOIN `Project` p ON p.`id` = t.`projectId` ' +
        'SET t.`orgId` = p.`orgId` WHERE t.`orgId` IS NULL AND p.`orgId` IS NOT NULL',
    },
    {
      label: 'from author',
      sql:
        'UPDATE `ProjectTaskTemplate` t JOIN `User` u ON u.`id` = t.`createdById` ' +
        'SET t.`orgId` = u.`orgId` WHERE t.`orgId` IS NULL AND t.`projectId` IS NULL AND u.`orgId` IS NOT NULL',
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
      if (n) console.log(`backfill-task-template-org: ${n} row(s) ${label}`);
    }
    console.log(`backfill-task-template-org: ${total} row(s) attributed; the rest go to the default org.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('backfill-task-template-org failed:', e);
    process.exit(1);
  });
}
