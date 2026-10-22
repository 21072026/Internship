import { holdsLease, replicaId, SCHEDULER_LEASE } from './lease';

// The scheduler's cadence and lease (#1676). The 30 s queue tick
// (`./schedulerRuntime`) takes or renews the 'scheduler' lease through here;
// only the holder enqueues. (The node-cron timers that also leased through this
// file are gone since #1677 — every schedule is on the queue.)
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
