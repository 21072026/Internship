// Retire the `premiumAnalytics` setting into ADVANCED_ANALYTICS org grants (#1740).
//
// WHY THIS EXISTS. The premium analytics tier used to be a Setting row — read
// tenant row → global row → default 'false' — and is now an entitlement asked
// through entitled(orgId, 'ADVANCED_ANALYTICS'): the org's plan or an
// OrgEntitlement grant. An org that had the tier switched on must not lose it on
// the deploy that removes the setting, so every org whose EFFECTIVE value was
// 'true' gets a permanent grant, noted with where it came from.
//
// Then the setting rows are deleted. Not cosmetic: nothing reads them any more,
// and a surviving GLOBAL 'true' row would make every re-run of this script hand
// the tier to each org created since — a paid feature leaking to new tenants on
// every deploy. With the rows gone, a re-run finds nothing and prints zeros.
//
// The effective-value rule is restated here from getSetting() in
// src/lib/settings.ts (tenant row → global row → default) because this runs as
// plain node inside the built image, with no TypeScript toolchain — the same
// reason backfill-org-subscription.mjs restates LEGACY_PLAN_MAP.
//
// Run: node prisma/backfill-premium-analytics-entitlement.mjs   [--dry-run]

import { PrismaClient } from '@prisma/client';

const KEY = 'premiumAnalytics';
const FEATURE = 'ADVANCED_ANALYTICS';
const NOTE = 'Migrated from the retired premiumAnalytics setting (#1740).';

/** Orgs whose effective setting value was 'true', by getSetting()'s rule. */
export function orgsWithTier(orgIds, rows) {
  const global = rows.find((r) => r.orgId === null)?.value;
  const byOrg = new Map(rows.filter((r) => r.orgId !== null).map((r) => [r.orgId, r.value]));
  return orgIds.filter((id) => (byOrg.has(id) ? byOrg.get(id) : global ?? 'false') === 'true');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.setting.findMany({ where: { key: KEY }, select: { orgId: true, value: true } });
    if (rows.length === 0) {
      console.log('backfill-premium-analytics-entitlement: no premiumAnalytics rows — nothing to migrate');
      return;
    }
    const orgs = await prisma.organization.findMany({ select: { id: true } });
    const entitled = orgsWithTier(orgs.map((o) => o.id), rows);
    console.log(`backfill-premium-analytics-entitlement: ${rows.length} setting row(s), ${entitled.length} org(s) had the tier`);
    if (dryRun) return;
    await prisma.$transaction(async (tx) => {
      if (entitled.length > 0) {
        await tx.orgEntitlement.createMany({
          data: entitled.map((orgId) => ({ orgId, feature: FEATURE, note: NOTE })),
          skipDuplicates: true,
        });
      }
      await tx.setting.deleteMany({ where: { key: KEY } });
    });
    console.log(`backfill-premium-analytics-entitlement: granted ${FEATURE} to ${entitled.length} org(s), removed ${rows.length} setting row(s)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('backfill-premium-analytics-entitlement failed:', error);
    process.exit(1);
  });
}
