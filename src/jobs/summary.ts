import type { JobSummary } from '@/lib/jobs/types';

/**
 * The counters of a sweep's result, for its JobRun row: every finite number
 * kept, a boolean as 0/1, an array as its length — and nothing else. A result
 * may carry ids, dates or nested rows; none of that belongs in the ledger,
 * which an admin screen renders more or less verbatim (src/lib/jobs/types.ts).
 */
export function counters(result: unknown): JobSummary {
  const out: JobSummary = {};
  if (!result || typeof result !== 'object') return out;
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value ? 1 : 0;
    else if (Array.isArray(value)) out[key] = value.length;
  }
  return out;
}

/**
 * The per-attempt timeout of the ported sweeps (#1677). Generous on purpose: a
 * timeout fails the ATTEMPT but cannot stop the promise, so a mail sweep cut
 * off at the worker's default 5 min would be retried while the first run is
 * still sending. Half an hour is longer than any of them has ever run; the
 * heartbeat keeps the lease alive meanwhile.
 */
export const SWEEP_OPTS = { timeoutMs: 30 * 60_000 } as const;
