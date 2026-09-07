import cron from 'node-cron';
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
// `runUsageRollup()` is a PLAIN HANDLER on purpose: node-cron is the carrier
// only until the leader-elected scheduler (#1676) lands, at which point this
// becomes a `billing.usage-rollup` handler registered on the queue and the
// timer below goes away with the other twelve. Nothing about the job's logic
// changes when that happens.

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

const tasks = new Map<string, ReturnType<typeof cron.schedule>>();

/**
 * Register the nightly usage rollup in this server process. Idempotent — a
 * retried call from `/api/cron/start` is harmless.
 *
 * Registered from `/api/cron/start` rather than from `initCronJobs()`, the same
 * way the newsletter cron (#1469), the dead-letter alert (#1674) and the
 * retention prune (#1678) are. Nothing here sends mail, and `initCronJobs`
 * lives in the mail service: the billing meter has no business being owned by
 * the module that talks to SMTP.
 *
 * 02:40 UTC — in the quiet hours and clear of every other slot (03:20 the
 * retention prune, 06:45 the dead-letter alert, 07:30 activity digests,
 * 08:15/08:30 the Monday weeklies, 09:00 the reminder batch). Ahead of the
 * prune rather than behind it, so a month's usage is counted before anything
 * starts deleting rows out of the window it counted.
 *
 * node-cron is the carrier only until the scheduler story (#1676) lands, when
 * this becomes a queue handler; `runUsageRollup()` is the handler either way.
 */
export function initUsageRollupCron() {
  if (tasks.has('usage-rollup')) return;

  const task = cron.schedule('40 2 * * *', async () => {
    try {
      const result = await runUsageRollup();
      // A rollup that wrote nothing, or skipped a tenant, is worth a line; a
      // clean run is not — same discipline as the other scheduled jobs.
      if (result.failed > 0 || result.rows === 0) {
        logger.warning('Usage rollup ran', { ...result, periods: result.periods.join(',') });
      }
    } catch (e) {
      logger.error('Usage rollup cron failed', { error: String(e) });
    }
  });
  tasks.set('usage-rollup', task);
}
