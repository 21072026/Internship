// Job name → handler (#1673). The worker (`./worker`) claims only the names
// registered here, so a job kind nobody can run is never claimed and left
// RUNNING until its lease expires — it stays PENDING, and the start check below
// names it.
//
// Pure on purpose: no Prisma, no logger. Handlers are registered by
// `src/jobs/index.ts`, which the worker route imports; a test builds its own
// registry with `createJobRegistry()` and never touches the process-wide one.
//
// ── HANDLERS MUST BE IDEMPOTENT ─────────────────────────────────────────────
// Delivery is at-least-once (the contract is stated at the top of `./queue`):
// a container killed after the side effect but before SUCCEEDED, a retry after
// a late failure and an operator's manual re-run all run a handler a second
// time. A handler makes that harmless with a single-shot stamp
// (`reminderSentAt`, `digestedAt`, …) or a natural key, and says which in its
// doc comment.

import type { JobRecord } from './queue';
import type { JobName, JobPayloadMap, JobSummary } from './types';
import type { BackoffPolicy } from './workerRule';

export interface JobContext {
  job: JobRecord;
  /** 1-based number of this attempt. */
  attempt: number;
  /**
   * Aborted when the attempt times out or the worker shuts down. A handler
   * that loops over rows should check it between rows: the worker cannot kill
   * a promise, so a handler that ignores it keeps running after its attempt
   * was already recorded as failed.
   */
  signal: AbortSignal;
}

export type JobHandlerFn<P = unknown> = (payload: P, ctx: JobContext) => Promise<JobSummary | void> | JobSummary | void;

export interface JobHandlerOptions {
  /** Per-attempt timeout. Default `DEFAULT_JOB_TIMEOUT_MS` (5 min). */
  timeoutMs?: number;
  /** Retry spacing for this job name. Default `DEFAULT_BACKOFF` (30 s → 1 h). */
  backoff?: BackoffPolicy;
}

export interface RegisteredHandler extends JobHandlerOptions {
  name: string;
  run: JobHandlerFn;
}

export interface JobRegistry {
  register(name: string, run: JobHandlerFn, opts?: JobHandlerOptions): void;
  get(name: string): RegisteredHandler | undefined;
  names(): string[];
}

export function createJobRegistry(): JobRegistry {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    register(name, run, opts = {}) {
      // A second registration of the same name is a wiring mistake (two files
      // claiming one job), not something to resolve by "last one wins".
      if (handlers.has(name)) throw new Error(`job handler already registered: ${name}`);
      handlers.set(name, { name, run, ...opts });
    },
    get: (name) => handlers.get(name),
    names: () => [...handlers.keys()].sort(),
  };
}

/** The process-wide registry the worker route runs. */
export const jobRegistry: JobRegistry = createJobRegistry();

/** Typed registration: the payload type follows the job name (`./types`). */
export function registerJob<N extends JobName>(
  name: N,
  run: JobHandlerFn<JobPayloadMap[N]>,
  opts?: JobHandlerOptions
): void {
  jobRegistry.register(name, run as JobHandlerFn, opts);
}

export function getHandler(name: string): RegisteredHandler | undefined {
  return jobRegistry.get(name);
}

/**
 * Names that are waiting in the queue but that no handler here — and no
 * separate drain (`ownedElsewhere`, e.g. the mail outbox's 'email.send') — can
 * run. Empty means every queued job has an owner.
 */
export function unhandledJobNames(openNames: readonly string[], registry: JobRegistry, ownedElsewhere: readonly string[] = []): string[] {
  const known = new Set([...registry.names(), ...ownedElsewhere]);
  return [...new Set(openNames)].filter((n) => !known.has(n)).sort();
}
