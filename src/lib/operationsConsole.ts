import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { runUnscoped } from '@/lib/tenantAmbient';
import { sanitizeError } from '@/lib/sanitizeError';
import { queueScopeWhere } from '@/lib/mailQueueAdmin';
import type { QueueScope } from '@/lib/mailOpsRule';
import { QUEUE_SCHEDULES } from '@/lib/jobs/schedules';
import { manualKeyForJob } from '@/lib/jobs/manualJobs';
import { leaseSnapshot, type LeaseSnapshot } from '@/lib/jobs/lease';
import { trackerOrigin } from '@/lib/errorTrackingRule';
import { ERROR_WINDOWS, nextSlot, scheduleAlarms, type ScheduleAlarm } from '@/lib/jobs/operationsRule';

// The operations console's reader (#1607): one view over what already exists —
// the schedule registry (`schedules.ts`), `ScheduleState`, the `Job` + `JobRun`
// ledger and the `JobLease` rows. No second record of "did it run": every field
// below is read from the row that the scheduler, the worker or the lease writes.
//
// WHO SEES WHAT — the mail queue's rule, unchanged (`queueScopeFor()` in
// mailOpsRule.ts, resolved by `resolveQueueScope()`), because the job tables are
// the same deployment-wide tables the mail queue lives in:
//   • a super admin: every run of an org in their world, plus the org-less
//     platform runs when their world is the default one;
//   • the default organization's ADMIN: that organization's runs only;
//   • anybody else: nothing (the route answers 403 before this is called).
// The schedule registry and `ScheduleState` carry no tenant data (a key and a
// slot time), so both scopes see every schedule; the RUNS are what the scope
// filters. The lease rows are shown to a world-scoped operator only — a replica
// name is the deployment's, not the default organization's.
//
// Like the mail queue, every read runs `runUnscoped` with its OWN scope filter:
// an implicit session filter on top would narrow a super admin to one tenant.

export interface ScheduleRow {
  key: string;
  job: string;
  cron: string;
  why: string;
  lastEnqueuedSlot: string | null;
  nextSlot: string | null;
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    ok: boolean;
    durationMs: number | null;
    trigger: string;
    /** Through sanitizeError — a handler's throw can echo anything. */
    error: string | null;
  } | null;
  lastOkAt: string | null;
  alarms: ScheduleAlarm[];
  /** The `/api/cron?job=` key that re-runs this job, when one exists and the caller may use it. */
  rerunKey: string | null;
}

export interface OperationsView {
  scope: 'world' | 'organization';
  generatedAt: string;
  schedules: ScheduleRow[];
  errors: { failedRunsLastHour: number; failedRunsLast24h: number; deadLetter: number };
  /** World scope only. */
  leases?: LeaseSnapshot[];
  /**
   * The error tracker (#1600): whether a DSN is configured, and its origin to
   * link to. It counts nothing here — events live in the tracker, not in our
   * database — so the counts above stay the job ledger's.
   */
  tracker: { enabled: boolean; url: string | null };
}

const RUN_SELECT = { startedAt: true, finishedAt: true, ok: true, durationMs: true, trigger: true, error: true } as const;

export async function operationsView(scope: QueueScope, now: Date = new Date()): Promise<OperationsView> {
  const jobWhere: Prisma.JobWhereInput = await queueScopeWhere(scope);
  const runsVisible = scope.kind === 'world' && scope.includeOrgless;
  const jobNames = [...new Set(QUEUE_SCHEDULES.map((s) => s.job))];

  const [states, lastRuns, lastOks, failedHour, failedDay, deadLetter, leases] = await Promise.all([
    runUnscoped(() => prisma.scheduleState.findMany({ select: { name: true, lastEnqueuedSlot: true } })),
    Promise.all(
      jobNames.map((name) =>
        runUnscoped(() =>
          prisma.jobRun.findFirst({
            where: { job: { AND: [{ name }, jobWhere] } },
            orderBy: { startedAt: 'desc' },
            select: RUN_SELECT,
          }),
        ),
      ),
    ),
    Promise.all(
      jobNames.map((name) =>
        runUnscoped(() =>
          prisma.jobRun.findFirst({
            where: { ok: true, job: { AND: [{ name }, jobWhere] } },
            orderBy: { startedAt: 'desc' },
            select: { startedAt: true },
          }),
        ),
      ),
    ),
    runUnscoped(() =>
      prisma.jobRun.count({
        where: { ok: false, finishedAt: { not: null }, startedAt: { gt: new Date(now.getTime() - ERROR_WINDOWS.hour) }, job: jobWhere },
      }),
    ),
    runUnscoped(() =>
      prisma.jobRun.count({
        where: { ok: false, finishedAt: { not: null }, startedAt: { gt: new Date(now.getTime() - ERROR_WINDOWS.day) }, job: jobWhere },
      }),
    ),
    runUnscoped(() => prisma.job.count({ where: { AND: [{ status: 'DEAD_LETTER' }, jobWhere] } })),
    scope.kind === 'world' ? leaseSnapshot().catch(() => []) : Promise.resolve(undefined),
  ]);

  const tracker = trackerOrigin(process.env.ERROR_TRACKING_DSN);
  const stateByKey = new Map(states.map((s) => [s.name, s.lastEnqueuedSlot]));
  const runByJob = new Map(jobNames.map((n, i) => [n, lastRuns[i]]));
  const okByJob = new Map(jobNames.map((n, i) => [n, lastOks[i]]));

  const schedules: ScheduleRow[] = QUEUE_SCHEDULES.map((s) => {
    const run = runByJob.get(s.job) ?? null;
    const slot = stateByKey.get(s.key) ?? null;
    const manual = manualKeyForJob(s.job);
    return {
      key: s.key,
      job: s.job,
      cron: s.cron,
      why: s.why,
      lastEnqueuedSlot: slot?.toISOString() ?? null,
      nextSlot: nextSlot(s.cron, now)?.toISOString() ?? null,
      lastRun: run
        ? {
            startedAt: run.startedAt.toISOString(),
            finishedAt: run.finishedAt?.toISOString() ?? null,
            ok: run.ok,
            durationMs: run.durationMs,
            trigger: run.trigger,
            error: sanitizeError(run.error),
          }
        : null,
      lastOkAt: okByJob.get(s.job)?.startedAt.toISOString() ?? null,
      alarms: scheduleAlarms({ cron: s.cron, lastEnqueuedSlot: slot, stateMissing: !stateByKey.has(s.key), lastRun: run, runsVisible }, now),
      // A platform key takes a super admin at /api/cron — offer it only to one.
      rerunKey: manual && (!manual.platform || scope.kind === 'world') ? manual.key : null,
    };
  });

  return {
    scope: scope.kind === 'world' ? 'world' : 'organization',
    generatedAt: now.toISOString(),
    schedules,
    errors: { failedRunsLastHour: failedHour, failedRunsLast24h: failedDay, deadLetter },
    ...(leases ? { leases } : {}),
    tracker: { enabled: tracker !== null, url: tracker },
  };
}
