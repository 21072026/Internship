// Stamp ActivityLog.orgId on the rows written before the column existed
// (cross-world isolation). Node 20 ESM, no TS imports — the server runs it
// inside the image.
//
// WHY IT MUST RUN BEFORE backfill-organization.mjs
//   That script fills EVERY nullable orgId column with the default org. Run
//   first, it would hand a MARKETING admin's whole login history to the
//   INTERNSHIP admin (the default org) and leave the MARKETING admin's own
//   feed empty. So this pass attributes what it can by the rule in
//   src/lib/activityOrgRule.ts, and only the remainder — system rows with no
//   actor and no user target — falls to the default org there.
//
// THE RULE (mirrors pickActivityOrg; scripts/test/activity-log-org.test.mjs
// pins the two together): the actor's org first, then the target user's org
// for an entry ABOUT a user. An explicit org cannot exist on a legacy row.
//
// Idempotent: every statement touches `orgId IS NULL` rows only, and a user
// without an org is skipped (NULL → NULL is not an update). Raw SQL rather than
// updateMany for the same reason backfill-organization.mjs gives: the model
// has no @updatedAt today, but a bookkeeping pass should never look like an
// edit if one is added.
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** targetType values that name a User row — the same list as activityOrgRule.ts. */
export const USER_TARGET_TYPES = ['user', 'User'];

/** Pure mirror of pickActivityOrg(), for the parity test. */
export function pickActivityOrg({ explicitOrgId, actorOrgId, targetType, targetUserOrgId }) {
  if (explicitOrgId) return explicitOrgId;
  if (actorOrgId) return actorOrgId;
  if (targetType && USER_TARGET_TYPES.includes(targetType) && targetUserOrgId) return targetUserOrgId;
  return null;
}

/**
 * The statements, in rule order. Order matters: the actor pass runs first so a
 * row that has both an actor and a user target takes the actor's org.
 */
export function backfillStatements() {
  const types = USER_TARGET_TYPES.map((t) => `'${t}'`).join(', ');
  return [
    {
      label: 'from actor',
      sql:
        'UPDATE `ActivityLog` a JOIN `User` u ON u.`id` = a.`actorId` ' +
        'SET a.`orgId` = u.`orgId` WHERE a.`orgId` IS NULL AND u.`orgId` IS NOT NULL',
    },
    {
      label: 'from target user',
      sql:
        'UPDATE `ActivityLog` a JOIN `User` u ON u.`id` = a.`targetId` ' +
        `SET a.\`orgId\` = u.\`orgId\` WHERE a.\`orgId\` IS NULL AND a.\`targetType\` IN (${types}) ` +
        'AND u.`orgId` IS NOT NULL',
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
      if (n) console.log(`backfill-activity-log-org: ${n} row(s) ${label}`);
    }
    const [{ n: left }] = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) AS n FROM `ActivityLog` WHERE `orgId` IS NULL',
    );
    console.log(
      `backfill-activity-log-org: ${total} row(s) attributed; ${Number(left)} system row(s) left for ` +
        'backfill-organization.mjs (default org).',
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('backfill-activity-log-org failed:', e);
    process.exit(1);
  });
}
