import { prisma } from '@/lib/prisma';

// Job-queue health (#1674), DERIVED from the `Job` table the same way
// `emailHealth.ts` is derived from the EmailLog ledger — there is no separate
// counter to drift out of sync with the rows it claims to describe.
//
// Why this exists: a queue with a growing backlog, or a dead-letter table that
// is quietly filling up, fails *silently*. Nothing reports either number today,
// so the first symptom is a user noticing that an e-mail never arrived. These
// two counters are the cheapest possible eyes on both.
//
// PII rule: operational metadata only. No job name is a person, no payload is
// read, no orgId leaves this module — counters and one age in seconds. That is
// deliberate, because /api/health is reachable by callers this app does not
// otherwise trust (see the gating note in the route).
//
// Cost rule: this is THREE queries and it must stay that way. /api/health is in
// the nightly k6 anonymous-GET mix with a latency budget, and
// docs/testing.md warns that the endpoint already pays four EmailLog queries.
// So the caller only reaches this module behind BOTH the detail gate and an
// explicit `?jobs=1` — an anonymous probe issues exactly the queries it issued
// before this landed, which is none.

export interface JobQueueHealth {
  // Work waiting to be claimed, whether or not it is due yet.
  pending: number;
  // Claimed by a worker and still running (or holding a stale lease).
  running: number;
  // Retries exhausted — nothing will pick these up again without a human.
  deadLetter: number;
  // How long the oldest *due* pending job has been waiting, in seconds; null
  // when nothing is due. Depth alone cannot distinguish a healthy burst from a
  // stalled worker — age can, which is what an uptime monitor should alert on.
  oldestPendingAgeSec: number | null;
  // Jobs whose last state change in the past 24h left them FAILED or
  // DEAD_LETTER. A transient failure that later succeeded is not counted: the
  // row has moved on to SUCCEEDED.
  failedLast24h: number;
}

const COUNTED_STATUSES = ['PENDING', 'RUNNING', 'DEAD_LETTER'] as const;

export async function jobQueueHealth(): Promise<JobQueueHealth> {
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const [byStatus, oldestDue, failedLast24h] = await Promise.all([
    // One grouped count for the three depths, served by @@index([status, …]).
    prisma.job.groupBy({
      by: ['status'],
      where: { status: { in: [...COUNTED_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.job.findFirst({
      where: { status: 'PENDING', runAt: { lte: new Date(now) } },
      orderBy: { runAt: 'asc' },
      select: { runAt: true },
    }),
    prisma.job.count({
      where: { status: { in: ['FAILED', 'DEAD_LETTER'] }, updatedAt: { gt: dayAgo } },
    }),
  ]);

  const depth = (status: (typeof COUNTED_STATUSES)[number]) =>
    byStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    pending: depth('PENDING'),
    running: depth('RUNNING'),
    deadLetter: depth('DEAD_LETTER'),
    oldestPendingAgeSec: oldestDue
      ? Math.max(0, Math.round((now - oldestDue.runAt.getTime()) / 1000))
      : null,
    failedLast24h,
  };
}
