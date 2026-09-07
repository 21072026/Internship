import { prisma } from '@/lib/prisma';
import { RETENTION_ACTIVITY_ACTION } from '@/lib/retentionPrune';

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
// So the caller only reaches this module behind BOTH proof of identity (a
// matching HEALTH_TOKEN or an ADMIN session — never the route's fail-open
// detail branch) and an explicit `?jobs=1`: an anonymous probe issues exactly
// the queries it issued before this landed, which is none.

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

// Retention health (#1678), DERIVED the same way — from the `retention.pruned`
// ActivityLog row the daily sweep writes, not from a counter kept beside it.
//
// The question this answers is the one nothing can answer today: DID THE PRUNE
// RUN? A retention job that quietly stopped looks exactly like a retention job
// with nothing to do — both delete zero rows — and the difference between them
// is the difference between "clean" and "we are still holding personal data we
// said we would delete". The age of the last receipt tells them apart; the
// summary line says what that run actually removed.
//
// Cost rule, as above: ONE query, behind the same gate as the queue counters
// (`?jobs=1` AND proof of identity). That takes the opt-in jobs block from
// three queries to four; an anonymous /api/health still issues none.
export interface RetentionHealth {
  /** When the last sweep recorded itself, or null when there is no receipt at all. */
  lastRunAt: string | null;
  /** How long ago that was, in hours. Much over 24 means a run was missed. */
  ageHours: number | null;
  /** The per-table counts line, e.g. `pageView=340 job=88 (1.2s)`. */
  summary: string | null;
  /** True when the last run recorded a failing entry (its row is logged at WARNING). */
  degraded: boolean;
}

export async function retentionHealth(): Promise<RetentionHealth> {
  const last = await prisma.activityLog.findFirst({
    where: { action: RETENTION_ACTIVITY_ACTION },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, detail: true, level: true },
  });
  if (!last) return { lastRunAt: null, ageHours: null, summary: null, degraded: false };

  return {
    lastRunAt: last.createdAt.toISOString(),
    ageHours: Math.round(((Date.now() - last.createdAt.getTime()) / 3_600_000) * 10) / 10,
    summary: last.detail,
    degraded: last.level === 'WARNING' || last.level === 'ERROR',
  };
}
