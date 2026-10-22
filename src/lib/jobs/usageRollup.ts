import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
  COMPUTED_METRICS,
  activeMatchedPairs,
  countAdminSeats,
  rollupPeriods,
  setUsage,
  type Period,
  type UsageMetric,
} from '@/lib/metering';

// The nightly usage rollup (#1750).
//
// Once a night, for every tenant, it asks the meter what the month looks like
// and writes the answer into UsageRollup. Two reasons it exists rather than the
// invoice screen computing on demand:
//
//   1. The billable-pair definition is a scan across seven activity tables. A
//      request path must never do that (the acceptance criterion says so), and
//      a dashboard that recomputes on every refresh gets slower exactly as a
//      tenant grows.
//   2. A month that has closed must keep the number it closed with. The rollup
//      is the record; the domain tables keep moving.
//
// IDEMPOTENT BY CONSTRUCTION. Every metric it writes is a COMPUTED one, written
// absolutely through `setUsage()` onto the unique (orgId, metric, period)
// triple. Running it twice — or ten times — for the same day writes the same
// value onto the same row, so a re-run can neither double-count nor leave a
// second row behind. The counters (video rooms, activity signals) are
// deliberately NOT recomputed here: an increment is not idempotent, which is
// precisely why they are incremented at the source instead.
//
// WHICH PERIODS. The open month and the one before it. The previous month is
// re-read for a few weeks after it closes because activity is still being
// *logged* into it (an interaction backdated to last Thursday is exactly the
// InteractionLog.date case the rule is written around), and because the first
// run of a new month would otherwise leave the old one at whatever value the
// last nightly tick of that month happened to see.
//
// `runUsageRollup()` is a PLAIN HANDLER on purpose: it runs as the queued job
// `usage.rollup` (src/lib/jobs/schedules.ts, src/jobs/platform.ts, #1677), and
// nothing about its logic depends on what carries it.

export interface UsageRollupResult {
  orgs: number;
  periods: Period[];
  /** Rows written (upserted). One per org × period × computed metric. */
  rows: number;
  /** Orgs whose rollup failed; the run continues past them. */
  failed: number;
}

/** Compute one metric for one tenant and one period. */
async function computeMetric(metric: UsageMetric, orgId: string, period: Period): Promise<number> {
  switch (metric) {
    case 'ACTIVE_MATCHED_PAIRS':
      return activeMatchedPairs(orgId, period);
    // Seats are a point-in-time count: "how many admin seats does this tenant
    // have?" has no month-shaped answer, and the honest thing is to stamp the
    // open period with what is true when the rollup runs rather than to invent
    // a historical reconstruction of a table that records no history. Which is
    // also why a closed period keeps the last value written for it.
    case 'ADMIN_SEATS':
      return countAdminSeats(orgId);
    default:
      // COMPUTED_METRICS is derived from the catalogue, so a metric added there
      // without a branch here lands loudly instead of silently writing zero.
      throw new Error(`No rollup computation for metric ${metric}`);
  }
}

/**
 * Recompute and store every COMPUTED metric for every tenant, for the open
 * period and the previous one. Safe to re-run at any time.
 *
 * `orgIds` narrows the run to named tenants — for a targeted re-run and for
 * the spec, which must not write rollup rows for organisations it did not
 * seed. `now` is injectable for the same reason: a billing period is only
 * testable if the clock is.
 */
export async function runUsageRollup(opts: { now?: Date; orgIds?: string[] } = {}): Promise<UsageRollupResult> {
  const periods = rollupPeriods(opts.now ?? new Date());
  const orgs = await prisma.organization.findMany({
    where: opts.orgIds ? { id: { in: opts.orgIds } } : undefined,
    select: { id: true },
  });

  let rows = 0;
  let failed = 0;
  for (const org of orgs) {
    try {
      for (const period of periods) {
        for (const metric of COMPUTED_METRICS) {
          const value = await computeMetric(metric, org.id, period);
          await setUsage({ orgId: org.id, metric, period, value });
          rows++;
        }
      }
    } catch (e) {
      // One tenant's failure must not cost every other tenant their invoice
      // line. Loud, because a missing rollup row is a number nobody notices is
      // missing until it is on a bill.
      failed++;
      logger.error('Usage rollup failed for one organisation', { orgId: org.id, error: String(e) });
    }
  }

  return { orgs: orgs.length, periods: [...periods], rows, failed };
}


