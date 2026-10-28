// The job worker (#1673): claim → run under a timeout → record → settle.
//
// The rules it applies (backoff, dead-letter, error text) are pure in
// `./workerRule`; the queue primitives (`claim`, `recordRun`, the reap) are
// `./queue`'s; name → handler is `./registry`. This file is only the loop, and
// it takes every collaborator as an argument so the whole of it runs against
// `createMemoryQueueStore()` in `e2e/job-worker.unit.spec.ts`.
//
// HOW IT IS DRIVEN. Not by a timer of its own: `src/instrumentation.ts` POSTs
// `/api/jobs/worker/tick` every few seconds on every replica (the mail drain's
// pattern), and the route calls `tick()` on this process's one worker. A tick
// claims up to the FREE capacity (`concurrency − in flight`) and the request
// stays open until the jobs it claimed have settled. That is what makes a
// deploy graceful without a second signal handler fighting Next's own: on
// SIGTERM Next stops accepting connections — so no new tick, so no new claim —
// and waits for the open requests, i.e. for the jobs in flight. Overlapping
// ticks are fine and intended: a slow job holds one request, the next tick
// claims into the remaining capacity.
//
// SHUTDOWN, BELT AND BRACES. `shutdown(graceMs)` (wired to SIGTERM by the route)
// stops claiming at once, aborts every in-flight handler's signal after
// `graceMs`, and releases the leases of whatever is still running — back to
// PENDING with `attempts` untouched, so another replica picks it up at once
// instead of after the lease window. Whatever the container's SIGKILL still
// strands is reaped by the clock (`reapExpiredLeases`), as before.
//
// HEARTBEAT. While anything runs, every `heartbeatMs` the worker refreshes
// `lockedAt` on its own RUNNING rows, so a job longer than the lease is not
// reaped and run a second time by another replica while it is still working.
//
// NO LEASE. Like the mail drain, every replica runs a worker; SKIP LOCKED hands
// each job to exactly one of them. A `JobLease` here would be the second
// election mechanism CLAUDE.md forbids.

import {
  claim,
  DEFAULT_LEASE_MS,
  reapExpiredLeases,
  recordRun,
  type JobRecord,
  type QueueStore,
} from './queue';
import { isJobTrigger, type JobName, type JobTrigger } from './types';
import type { JobRegistry, RegisteredHandler } from './registry';
import { unhandledJobNames } from './registry';
import {
  DEFAULT_BACKOFF,
  DEFAULT_JOB_TIMEOUT_MS,
  errorText,
  failureOutcome,
  JobTimeoutError,
} from './workerRule';

export interface WorkerLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warning(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface WorkerOptions {
  store: QueueStore;
  registry: JobRegistry;
  workerId: string;
  /** Jobs this process runs at once. Default 2. */
  concurrency?: number;
  /** Lease window the reap applies. Default `DEFAULT_LEASE_MS` (5 min). */
  leaseMs?: number;
  /** How often `lockedAt` is refreshed while jobs run. Default leaseMs / 3. */
  heartbeatMs?: number;
  /** Names drained by something else (the mail outbox's 'email.send'). */
  ownedElsewhere?: readonly string[];
  now?: () => Date;
  random?: () => number;
  logger?: WorkerLogger;
  /**
   * Called once when a job lands in the dead-letter queue — the runtime writes
   * the `job.dead_letter` ActivityLog row (and its one logger.error) here.
   * Its own failure is logged and swallowed: the job is already settled.
   */
  onDeadLetter?: (job: JobRecord, error: string) => Promise<void> | void;
  /**
   * Called for every failed attempt with what the handler threw (#1600) — the
   * runtime reports it to the error tracker, a retry as a warning and a
   * dead-letter as an error. Fire and forget: never awaited, its failure
   * swallowed, so a tracker outage cannot change how the job settles.
   */
  onError?: (job: JobRecord, error: unknown, outcome: 'retried' | 'deadLettered') => void;
  /**
   * Runs a handler for a job that carries an `orgId` inside that tenant's
   * context (#1561/#1677) — the runtime passes `runWithOrg`. Only the handler
   * is bound: the queue's own reads and writes (claim, ledger, settle) stay
   * unbound, because they span every tenant by design. A job without an org
   * runs unbound, as the cron always did. Omitted: never bound (tests).
   */
  bindOrg?: <T>(orgId: string, fn: () => T) => T;
}

export interface TickSummary {
  reaped: number;
  claimed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
  released: number;
}

export interface JobWorker {
  /** Claim into free capacity and run what was claimed; resolves when those jobs have settled. */
  tick(): Promise<TickSummary>;
  /** Stop claiming, wait up to `graceMs` for in-flight jobs, release the rest. */
  shutdown(graceMs: number): Promise<{ released: number }>;
  /** Queued names no handler can run. Logged as an error when non-empty. */
  checkHandlers(): Promise<string[]>;
  inFlight(): number;
  stopping(): boolean;
}

const silent: WorkerLogger = { info: () => {}, warning: () => {}, error: () => {} };

type Outcome = 'succeeded' | 'retried' | 'deadLettered' | 'released';

interface Running {
  job: JobRecord;
  abort: AbortController;
  done: Promise<Outcome>;
}

export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 16;

/** `JOBS_CONCURRENCY`, clamped to 1…16; anything unreadable is the default. */
export function concurrencyFromEnv(raw: string | undefined): number {
  const n = Number.parseInt((raw || '').trim(), 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, n);
}

/** `JOBS_WORKER_ENABLED` — on unless explicitly switched off, like MAIL_WORKER_ENABLED. */
export function workerEnabled(raw: string | undefined): boolean {
  return !['0', 'false', 'off', 'no'].includes((raw || '').trim().toLowerCase());
}

export function createWorker(opts: WorkerOptions): JobWorker {
  const { store, registry, workerId } = opts;
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? DEFAULT_CONCURRENCY));
  const leaseMs = Math.max(1_000, Math.trunc(opts.leaseMs ?? DEFAULT_LEASE_MS));
  const heartbeatMs = Math.max(50, Math.trunc(opts.heartbeatMs ?? leaseMs / 3));
  const now = opts.now ?? (() => new Date());
  const random = opts.random ?? Math.random;
  const log = opts.logger ?? silent;
  const ownedElsewhere = opts.ownedElsewhere ?? [];

  const running = new Map<string, Running>();
  let stopping = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const startHeartbeat = () => {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      const ids = [...running.keys()];
      if (ids.length === 0) return;
      store.heartbeat({ ids, workerId, now: now() }).catch((e) => {
        log.warning('job_worker.heartbeat_failed', { error: errorText(e) });
      });
    }, heartbeatMs);
    heartbeat.unref?.();
  };
  const stopHeartbeatIfIdle = () => {
    if (running.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  const settle = async (job: JobRecord, data: Parameters<QueueStore['settleJob']>[0]['data']): Promise<boolean> => {
    try {
      const ok = await store.settleJob({ id: job.id, workerId, data });
      // Lost: the lease was reaped and the row re-claimed (or released by a
      // shutdown). The newer owner's outcome stands; this one is dropped.
      if (!ok) log.warning('job_worker.settle_lost', { jobId: job.id, name: job.name });
      return ok;
    } catch (e) {
      // The row stays RUNNING and is reaped after the lease — at-least-once.
      log.error('job_worker.settle_failed', { jobId: job.id, name: job.name, error: errorText(e) });
      return false;
    }
  };

  const runWithTimeout = (handler: RegisteredHandler, job: JobRecord, attempt: number, abort: AbortController) => {
    const timeoutMs = Math.max(1, handler.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new JobTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    // `.then` so a handler that throws synchronously is a rejection like any other.
    const call = () => handler.run(job.payload, { job, attempt, signal: abort.signal });
    const work = Promise.resolve().then(() => (job.orgId && opts.bindOrg ? opts.bindOrg(job.orgId, call) : call()));
    // A handler that outlives its timeout keeps running (a promise cannot be
    // killed); its late rejection must not surface as an unhandled one.
    work.catch(() => {});
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  const runOne = async (job: JobRecord, abort: AbortController): Promise<Outcome> => {
    const attempt = job.attempts + 1;
    const handler = registry.get(job.name);
    const trigger: JobTrigger = isJobTrigger(job.trigger) ? job.trigger : 'schedule';
    try {
      if (!handler) throw new Error(`no handler registered for job '${job.name}'`);
      await recordRun(job.id, attempt, trigger, () => runWithTimeout(handler, job, attempt, abort), { store, now });
      await settle(job, { status: 'SUCCEEDED', attempts: attempt, lastError: null });
      return 'succeeded';
    } catch (e) {
      const message = errorText(e);
      // Shut down mid-attempt: the abort came from shutdown(), not from the
      // handler. Not this job's fault — its lease is released by shutdown().
      if (stopping && abort.signal.aborted && !(e instanceof JobTimeoutError)) return 'released';
      const outcome = failureOutcome(attempt, job.maxAttempts, now(), handler?.backoff ?? DEFAULT_BACKOFF, random);
      if (opts.onError) {
        try {
          opts.onError({ ...job, attempts: attempt }, e, outcome.status === 'DEAD_LETTER' ? 'deadLettered' : 'retried');
        } catch {
          // The job's settle below matters; the report does not.
        }
      }
      if (outcome.status === 'DEAD_LETTER') {
        const settled = await settle(job, { status: 'DEAD_LETTER', attempts: attempt, lastError: message });
        if (settled && opts.onDeadLetter) {
          try {
            await opts.onDeadLetter({ ...job, attempts: attempt, lastError: message }, message);
          } catch (hookError) {
            log.warning('job_worker.dead_letter_hook_failed', { jobId: job.id, error: errorText(hookError) });
          }
        }
        return 'deadLettered';
      }
      await settle(job, { status: 'PENDING', attempts: attempt, lastError: message, runAt: outcome.runAt });
      return 'retried';
    }
  };

  const start = (job: JobRecord): Running => {
    const abort = new AbortController();
    const entry: Running = { job, abort, done: Promise.resolve('released' as Outcome) };
    entry.done = runOne(job, abort).finally(() => {
      running.delete(job.id);
      stopHeartbeatIfIdle();
    });
    running.set(job.id, entry);
    startHeartbeat();
    return entry;
  };

  return {
    async tick() {
      const summary: TickSummary = { reaped: 0, claimed: 0, succeeded: 0, retried: 0, deadLettered: 0, released: 0 };
      // Registry names are plain strings so a test can register its own kinds;
      // the queue's filter is typed by the production union.
      const names = registry.names() as JobName[];
      if (stopping || names.length === 0) return summary;

      try {
        summary.reaped = await reapExpiredLeases(leaseMs, { store, now, names });
      } catch (e) {
        log.warning('job_worker.reap_failed', { error: errorText(e) });
      }

      const free = concurrency - running.size;
      if (free <= 0) return summary;
      let rows: JobRecord[] = [];
      try {
        rows = await claim(workerId, { store, now, limit: free, leaseMs, names });
      } catch (e) {
        log.warning('job_worker.claim_failed', { error: errorText(e) });
        return summary;
      }
      // A shutdown that began while the claim was in the air: hand them back.
      if (stopping) {
        for (const job of rows) {
          if (await settle(job, { status: 'PENDING', attempts: job.attempts, lastError: job.lastError })) summary.released += 1;
        }
        return summary;
      }
      summary.claimed = rows.length;
      const outcomes = await Promise.all(rows.map((job) => start(job).done));
      for (const o of outcomes) summary[o] += 1;
      return summary;
    },

    async shutdown(graceMs) {
      stopping = true;
      const inFlight = [...running.values()];
      if (inFlight.length === 0) return { released: 0 };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(inFlight.map((r) => r.done)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, graceMs));
        }),
      ]);
      clearTimeout(timer);
      let released = 0;
      for (const r of [...running.values()]) {
        r.abort.abort();
        // attempts untouched: the attempt never reported a result, exactly as
        // a reaped lease. runAt is left alone, so the job is due at once.
        if (await settle(r.job, { status: 'PENDING', attempts: r.job.attempts, lastError: r.job.lastError })) released += 1;
      }
      if (released > 0) log.info('job_worker.released_on_shutdown', { released });
      return { released };
    },

    async checkHandlers() {
      let open: string[] = [];
      try {
        open = await store.openJobNames();
      } catch (e) {
        log.warning('job_worker.handler_check_failed', { error: errorText(e) });
        return [];
      }
      const missing = unhandledJobNames(open, registry, ownedElsewhere);
      if (missing.length > 0) {
        // Said at start, not discovered at 03:40: these rows will sit PENDING
        // until a handler for them is deployed.
        log.error('job_worker.unregistered_jobs', { names: missing });
      }
      return missing;
    },

    inFlight: () => running.size,
    stopping: () => stopping,
  };
}
