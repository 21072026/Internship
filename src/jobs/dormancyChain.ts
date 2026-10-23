// The dormancy chain (#1677) — kept free of Prisma and the mail service so the
// unit test can run it against the in-memory queue. Why it is a chain at all is
// in the header of ./reminders.ts.
import type { JobHandlerFn } from '@/lib/jobs/registry';
import { counters } from './summary';

/** The jobs the dormancy sweep enqueues on success, in this order. */
export const DORMANCY_CHAIN = ['dormancy.checkIn', 'reminders.mentorInteraction'] as const;

/**
 * The sweep handler, with its two collaborators injectable so the chain can be
 * exercised against the in-memory queue (e2e/job-cron-handlers.unit.spec.ts).
 * A throwing sweep never reaches the loop — that is the whole ordering rule.
 */
export function dormancySweepHandler(deps: {
  sweep: () => Promise<object>;
  enqueueNext: (name: (typeof DORMANCY_CHAIN)[number], key: string, trigger: 'schedule' | 'manual') => Promise<unknown>;
}): JobHandlerFn {
  return async (_p, { job }) => {
    const r = await deps.sweep();
    const trigger = job.trigger === 'manual' ? 'manual' : 'schedule';
    for (const next of DORMANCY_CHAIN) await deps.enqueueNext(next, `${job.id}:${next}`, trigger);
    return { ...counters(r), chained: DORMANCY_CHAIN.length };
  };
}
