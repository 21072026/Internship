import cron from 'node-cron';
import { holdsLease, replicaId, SCHEDULER_LEASE } from './lease';

// The scheduler's cadence and lease (#1676), shared by both carriers in
// `./schedules`: the 30 s queue tick (`./schedulerRuntime`) and every
// node-cron timer still in its own module.
export const SCHEDULER_TICK_MS = 30_000;
/** Three ticks: a holder that misses two renewals in a row is presumed dead. */
export const SCHEDULER_LEASE_TTL_MS = 90_000;

let stopped = false;

/**
 * This process is shutting down: never take the lease again, so the release
 * that follows sticks instead of being re-taken by the next timer to fire.
 */
export function stopSchedulerLeasing(): void {
  stopped = true;
}

/** Take or renew the 'scheduler' lease for this replica. False = not the holder (quiet). */
export async function holdsSchedulerLease(): Promise<boolean> {
  if (stopped) return false;
  return holdsLease(SCHEDULER_LEASE, replicaId(), SCHEDULER_LEASE_TTL_MS);
}

/**
 * `cron.schedule()`, but the body runs only on the 'scheduler' lease holder.
 *
 * Every replica registers the timer and every one of them fires; the ones that
 * do not hold the lease return without a word (lease rule 3), and an
 * unreachable database counts as "not the holder" (rule 4) — a skipped reminder
 * mails late, a doubled one cannot be unmailed. This is what retires the
 * `CRON_ENABLED=0` pin on replica ≥ 2. Missed slots are NOT caught up here; that
 * comes with the move onto the queue (#1677).
 */
export function scheduleLeased(expr: string, fn: () => unknown): ReturnType<typeof cron.schedule> {
  return cron.schedule(expr, async () => {
    if (!(await holdsSchedulerLease())) return;
    await fn();
  });
}
