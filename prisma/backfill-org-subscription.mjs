// Give every existing Organization a Subscription row (#1731, epic #1727).
//
// WHY THIS EXISTS. Before this task a tenant's whole commercial state was the
// `Organization.plan` enum. The new `Subscription` table is where it lives from
// now on, and every later billing screen is written assuming the row is there.
// An org that predates the table has none, so this translates what it already
// had — FREE → community, PRO → program, ENTERPRISE → enterprise — into a row.
// Nobody loses access on the deploy that adds the table.
//
// Idempotent and safe to re-run: it only ever creates a row for an org that has
// none, and NEVER edits an existing one. That matters more than it looks —
// re-running must not undo a plan change made in the app, and once Stripe is
// wired up (a later task) the provider is the authority for these fields, not
// this script. On a database that has already been backfilled it prints zeros.
//
// The legacy translation is duplicated from LEGACY_PLAN_MAP in src/lib/plans.ts
// rather than imported: this runs as plain node inside the built image, which
// has no TypeScript toolchain (same reason backfill-sso-plan.mjs re-states the
// SSO predicate). scripts/test/plans.test.mjs asserts the two copies agree, so
// packaging that changes in one place and not the other is a red build rather
// than a silently mis-planned tenant.
//
// Run: node prisma/backfill-org-subscription.mjs   [--dry-run]

import { PrismaClient } from '@prisma/client';

// MUST equal LEGACY_PLAN_MAP in src/lib/plans.ts (asserted by the unit test).
export const LEGACY_PLAN_MAP = {
  FREE: 'community',
  PRO: 'program',
  ENTERPRISE: 'enterprise',
};

// An unexpected/unreadable legacy plan resolves to the free tier, never to a
// paid one: guessing upwards hands out the paid product for free, guessing
// downwards is visible and fixable in one click.
function planKeyFor(plan) {
  return LEGACY_PLAN_MAP[plan] ?? LEGACY_PLAN_MAP.FREE;
}

// The Prisma client is constructed inside run(), not at module scope, so that
// importing this file costs nothing and needs no DATABASE_URL — that is what
// lets scripts/test/plans.test.mjs import LEGACY_PLAN_MAP above and compare it
// with the TypeScript matrix.
async function run(prisma, { dryRun }) {
  const orgs = await prisma.organization.findMany({
    select: { id: true, slug: true, plan: true, subscription: { select: { id: true } } },
  });

  let created = 0;
  let skipped = 0;

  for (const org of orgs) {
    if (org.subscription) {
      skipped++;
      continue;
    }

    const planKey = planKeyFor(org.plan);

    if (dryRun) {
      created++;
      console.log(`backfill-org-subscription: WOULD create ${org.slug} ${org.plan} -> ${planKey}`);
      continue;
    }

    try {
      await prisma.subscription.create({
        data: { orgId: org.id, planKey, status: 'ACTIVE', interval: 'MONTHLY' },
      });
      created++;
      console.log(`backfill-org-subscription: ${org.slug} ${org.plan} -> ${planKey}`);
    } catch (error) {
      // A concurrent create is not a failure: the app's own lazy
      // getOrCreateSubscription() runs against the same database while this
      // deploys, and `orgId` is unique, so the row the caller wanted exists
      // either way.
      const row = await prisma.subscription.findUnique({ where: { orgId: org.id }, select: { id: true } });
      if (!row) throw error;
      skipped++;
    }
  }

  console.log(
    `backfill-org-subscription: created=${created} already-had-one=${skipped} orgs=${orgs.length}` +
      `${dryRun ? ' (dry run)' : ''}`,
  );
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await run(prisma, { dryRun: process.argv.includes('--dry-run') });
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked as a script; an import (the unit test) just gets the map.
if (process.argv[1]?.endsWith('backfill-org-subscription.mjs')) {
  main().catch((error) => {
    console.error('backfill-org-subscription failed:', error);
    process.exitCode = 1;
  });
}
