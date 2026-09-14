// The job queue engine (#1671) — the rules half.
//
// One table (`Job`) holds work that must happen, one table (`JobRun`) holds
// what happened on each attempt, and a claim query hands a job to exactly one
// worker even when two containers are racing. Nothing here *runs* a job: the
// worker loop is #1673 and the schedule registry is #1676. This module is the
// durable substrate they plug into.
//
// ── DELIVERY IS AT-LEAST-ONCE. HANDLERS MUST BE IDEMPOTENT. ─────────────────
//
// That is not a caveat, it is the contract. Three ordinary events deliver the
// same job twice, and none of them is a bug:
//
//   • A worker claims a job, does the work, and the container is killed before
//     it can write SUCCEEDED. The lease expires, `reapExpiredLeases()` returns
//     the row to PENDING, and another worker does the work again.
//   • A handler fails *after* its side effect (the mail went out, the write
//     to a third party succeeded) and the retry re-runs the whole handler.
//   • An operator re-runs a job by hand from the operations console (#1607).
//
// Exactly-once delivery across a process boundary is not available without the
// side effect and the queue update sharing one transaction, which they cannot
// when the side effect is an SMTP conversation. So the queue promises the only
// thing it can keep — the job will run at least once — and the HANDLER is
// responsible for making a second run harmless. `enqueue()`'s `idempotencyKey`
// solves the adjacent, different problem: the same job being *enqueued* twice.
//
// ── REQUIRES MySQL 8.0.1 OR NEWER ───────────────────────────────────────────
//
// `claim()` rests on `SELECT … FOR UPDATE SKIP LOCKED`, which MySQL added in
// **8.0.1** (and MariaDB added in 10.6 with different semantics). Both
// deployments are well past it — the server runs MySQL 8.0.46 and CI runs the
// `mysql:8.0` image (`docs/server-migration.md`, `infra/server/bootstrap.sh`,
// `.github/workflows/e2e.yml`) — and `infra/server/bootstrap.sh` pins the image
// so they cannot drift apart. On an older engine the statement is a SYNTAX
// ERROR rather than a slow path, so the failure is loud, which is the right
// direction: silently falling back to a plain `FOR UPDATE` would make two
// workers queue behind one lock and look like a performance problem while
// quietly serialising the whole queue.
//
// ── STRUCTURE ───────────────────────────────────────────────────────────────
//
// The RULES live here and take a `QueueStore`; the Prisma-shaped row access
// lives in `./queueStore`, loaded lazily. Same split, and for the same reason,
// as `lease.ts` / `leaseStore.ts`: the rules stay testable without a database,
// and nothing here constructs a Prisma client just by being imported.
//
// The raw claim SQL is in `./queueStore` because it is row access, but it is
// the heart of this module and its safety argument is stated here:
//
//   SELECT id FROM `Job`
//    WHERE status = 'PENDING' AND runAt <= ?
//    ORDER BY priority DESC, runAt ASC
//    LIMIT ? FOR UPDATE SKIP LOCKED
//
// `FOR UPDATE` takes a write lock on every row the SELECT returns, inside the
// caller's transaction. `SKIP LOCKED` makes a *second* transaction step over
// the rows the first one has locked instead of blocking on them. So two workers
// running this at the same instant get two DISJOINT sets of ids, and the UPDATE
// that follows — still inside the same transaction — is uncontended. Without
// `SKIP LOCKED` the second worker blocks until the first commits and then reads
// the rows as already RUNNING, which is correct but serial. Without `FOR
// UPDATE` there is no lock at all and both workers claim the same job.
//
// The UPDATE re-asserts `status = 'PENDING'` anyway. That is belt and braces
// for a row whose state changed by some path that is not this query (an admin
// cancelling a job, a future bulk requeue), and it costs nothing.

import type { JobName, JobPayloadMap, JobSummary, JobTrigger } from './types';

// ── Row shapes ──────────────────────────────────────────────────────────────
//
// Declared structurally rather than imported from `@prisma/client` so this
// module carries no Prisma import at all, not even a type-only one that a
// future refactor could turn into a value import. Prisma's generated `Job`
// row is assignable to `JobRecord`.

export type JobStatusName =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'DEAD_LETTER'
  | 'CANCELLED';

export interface JobRecord {
  id: string;
  name: string;
  payload: unknown;
  status: JobStatusName;
  priority: number;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  idempotencyKey: string | null;
  orgId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewJob {
  name: string;
  payload: unknown;
  runAt: Date;
  priority: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  orgId: string | null;
}

export interface NewJobRun {
  jobId: string;
  attempt: number;
  trigger: JobTrigger;
  startedAt: Date;
}

export interface JobRunPatch {
  finishedAt: Date;
  durationMs: number;
  ok: boolean;
  error: string | null;
  summary: JobSummary | null;
}

// ── The store seam ──────────────────────────────────────────────────────────

export interface QueueStore {
  /**
   * `INSERT` one job. Throws on a unique-constraint collision with an existing
   * `idempotencyKey` — `enqueue()` turns that throw into the existing row, and
   * it must be a throw rather than a silent no-op so the collision is
   * distinguishable from a successful insert.
   */
  insertJob(data: NewJob): Promise<JobRecord>;
  /** The row an `idempotencyKey` already names, or null. */
  findJobByIdempotencyKey(key: string): Promise<JobRecord | null>;
  /**
   * ONE transaction: `SELECT … FOR UPDATE SKIP LOCKED` over due PENDING rows,
   * then `UPDATE … SET status='RUNNING', lockedAt=?, lockedBy=?` over exactly
   * those ids. Returns the claimed rows, payload included. Never blocks on a
   * row another worker is claiming; returns fewer rows than `limit`, or none,
   * rather than waiting.
   */
  claimDue(input: { now: Date; limit: number; workerId: string }): Promise<JobRecord[]>;
  /**
   * `UPDATE Job SET status='PENDING', lockedAt=NULL, lockedBy=NULL WHERE
   * status='RUNNING' AND lockedAt < ?`. Returns how many rows moved. Must not
   * touch `attempts` — see `reapExpiredLeases()`.
   */
  reapExpired(input: { lockedBefore: Date }): Promise<number>;
  /** `INSERT` the ledger row for one attempt; resolves its id. */
  insertRun(row: NewJobRun): Promise<string>;
  /** Stamp the finishing fields on a ledger row. */
  finishRun(runId: string, patch: JobRunPatch): Promise<void>;
  /** `DELETE FROM JobRun WHERE startedAt < ?`. Returns how many rows went. */
  deleteRunsStartedBefore(cutoff: Date): Promise<number>;
}

export interface QueueOptions {
  store?: QueueStore;
  /** Injectable clock, so every timestamp in a test is deterministic. */
  now?: () => Date;
}

async function resolveStore(opts: QueueOptions): Promise<QueueStore> {
  if (opts.store) return opts.store;
  // Lazy, so a unit test that always injects a store never resolves Prisma.
  const mod = await import('./queueStore');
  return mod.prismaQueueStore();
}

function clockOf(opts: QueueOptions): () => Date {
  return opts.now ?? (() => new Date());
}

// ── Logging ─────────────────────────────────────────────────────────────────
//
// Injected rather than imported, matching `lease.ts`. Only the ledger's own
// failures are logged from this module: they are invisible everywhere else by
// construction (the job carries on regardless), so a log line is the only trace
// they leave.

export interface QueueLogger {
  warning(message: string, context?: Record<string, unknown>): void;
}

let logger: QueueLogger = {
  warning: (message, context) => console.warn(`[job-queue] ${message}`, context ?? {}),
};

export function setQueueLogger(next: QueueLogger): void {
  logger = next;
}

// ── enqueue ─────────────────────────────────────────────────────────────────

export interface EnqueueOptions extends QueueOptions {
  /** Earliest moment the job may run. Defaults to now (i.e. immediately due). */
  runAt?: Date;
  /** Higher runs first. The claim query orders by `priority DESC, runAt ASC`. */
  priority?: number;
  maxAttempts?: number;
  /**
   * De-duplication at ENQUEUE time. The second `enqueue()` with the same key
   * produces no second row and returns the first one, so a producer that runs
   * twice (a retried HTTP request, a schedule that fired on two replicas before
   * #1676 leased the scheduler) does not double the work.
   *
   * Not a substitute for an idempotent handler: this key stops a second ROW,
   * not a second RUN of the row that already exists. See the delivery contract
   * at the top of this file.
   */
  idempotencyKey?: string | null;
  orgId?: string | null;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Put work on the queue.
 *
 * On a unique-constraint collision on `idempotencyKey` the EXISTING row is
 * returned instead of the error being propagated — that is the entire point of
 * the key, and a caller that has to catch P2002 itself would be doing the
 * de-duplication the key exists to do. Any other insert failure still throws:
 * swallowing, say, a connection error would silently drop the work.
 */
export async function enqueue<N extends JobName>(
  name: N,
  payload: JobPayloadMap[N],
  opts: EnqueueOptions = {}
): Promise<JobRecord> {
  const store = await resolveStore(opts);
  const now = clockOf(opts);
  const key = opts.idempotencyKey ?? null;

  const data: NewJob = {
    name,
    payload,
    runAt: opts.runAt ?? now(),
    priority: opts.priority ?? 0,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    idempotencyKey: key,
    orgId: opts.orgId ?? null,
  };

  try {
    return await store.insertJob(data);
  } catch (error) {
    // Only a keyed insert can collide on the key, so an unkeyed failure is
    // never the de-duplication case and is rethrown untouched.
    if (!key) throw error;
    const existing = await store.findJobByIdempotencyKey(key);
    // No row means the throw was something else entirely (a dead connection, a
    // column that does not fit) and must not be reported as a successful
    // enqueue. Rethrowing the ORIGINAL error keeps the real cause.
    if (!existing) throw error;
    return existing;
  }
}

// ── claim ───────────────────────────────────────────────────────────────────

export interface ClaimOptions extends QueueOptions {
  /** How many jobs to take in one go. Clamped to 1…`MAX_CLAIM_LIMIT`. */
  limit?: number;
  /**
   * How long the claim is good for. Not written to the row — the lease is
   * `lockedAt` plus this window, evaluated by `reapExpiredLeases()`, so a
   * changed lease length applies to jobs already running rather than only to
   * jobs claimed afterwards.
   */
  leaseMs?: number;
}

export const DEFAULT_CLAIM_LIMIT = 5;
export const MAX_CLAIM_LIMIT = 100;
export const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * Take up to `limit` due jobs for `workerId`, moving them to RUNNING.
 *
 * Exactly-one-owner is guaranteed by `SELECT … FOR UPDATE SKIP LOCKED` inside a
 * transaction (argument in the file header, SQL in `./queueStore`). More
 * workers are strictly better here — this is the opposite case to `lease.ts`,
 * and a worker must never take a `JobLease`.
 *
 * `attempts` is deliberately NOT incremented: the attempt/backoff/dead-letter
 * bookkeeping belongs to the worker loop (#1673), which is the only thing that
 * knows whether an attempt actually happened. Incrementing here would burn an
 * attempt on a claim whose container died before running anything.
 */
export async function claim(workerId: string, opts: ClaimOptions = {}): Promise<JobRecord[]> {
  const store = await resolveStore(opts);
  const now = clockOf(opts);
  const limit = Math.min(MAX_CLAIM_LIMIT, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_CLAIM_LIMIT)));
  if (!workerId) throw new Error('claim() needs a worker id: the lease has to name a holder.');
  return store.claimDue({ now: now(), limit, workerId });
}

// ── reapExpiredLeases ───────────────────────────────────────────────────────

/**
 * Return RUNNING jobs whose lease has expired to PENDING.
 *
 * A container that is SIGKILLed or OOM-killed releases nothing — a lease freed
 * only by a `finally` block is a lease held forever the first time a container
 * dies (the same argument as rule 1 in `lease.ts`). So a stale claim is
 * reclaimed by the CLOCK, not by the worker that lost it.
 *
 * `attempts` is left UNTOUCHED on purpose. The job was never attempted as far
 * as anybody can tell — no handler reported a result — and charging it a retry
 * would let a queue that keeps losing containers dead-letter healthy work.
 *
 * Returns how many rows moved, which is a number worth logging: a steadily
 * non-zero reap count means containers are dying mid-job, not that the queue
 * is healthy.
 */
export async function reapExpiredLeases(
  leaseMs: number = DEFAULT_LEASE_MS,
  opts: QueueOptions = {}
): Promise<number> {
  const store = await resolveStore(opts);
  const now = clockOf(opts);
  const window = Math.max(1_000, Math.trunc(leaseMs));
  return store.reapExpired({ lockedBefore: new Date(now().getTime() - window) });
}

// ── recordRun ───────────────────────────────────────────────────────────────

/**
 * Runtime half of the "counters only" rule.
 *
 * The TypeScript type (`Record<string, number>`) already makes a name or an
 * address unrepresentable, but types are erased and a handler can be reached
 * from JavaScript, so every value is re-checked here: anything that is not a
 * finite number is dropped, and an empty result becomes `null` rather than an
 * empty object that reads as "the handler reported nothing" either way.
 */
export function sanitizeSummary(value: unknown): JobSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: JobSummary = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Run `fn` and write the `JobRun` ledger row around it.
 *
 * The row is written BEFORE the handler, so a run that never finished still
 * leaves a trace — a job that wedges the container is exactly the one you most
 * need a row for, and a ledger written only on completion loses precisely those.
 *
 * EVERY LEDGER WRITE IS WRAPPED. A failure to record a run must never fail the
 * run itself: the ledger is an observability aid, and an observability aid that
 * can take down the work it observes is a liability. So a failed insert leaves
 * `runId` null and the handler runs anyway; a failed finishing stamp is logged
 * and swallowed.
 *
 * The HANDLER'S OWN THROW IS ALWAYS RETHROWN — recorded on the row first, then
 * propagated, because the worker (#1673) decides retry-or-dead-letter from it
 * and the error tracker (#1600) has to see it.
 */
export async function recordRun(
  jobId: string,
  attempt: number,
  trigger: JobTrigger,
  fn: () => Promise<JobSummary | void> | JobSummary | void,
  opts: QueueOptions = {}
): Promise<JobSummary | null> {
  const store = await resolveStore(opts);
  const now = clockOf(opts);
  const startedAt = now();

  let runId: string | null = null;
  try {
    runId = await store.insertRun({ jobId, attempt, trigger, startedAt });
  } catch (error) {
    logger.warning('could not open a JobRun row; the job runs unrecorded', {
      jobId,
      attempt,
      trigger,
      error: errorMessage(error),
    });
  }

  const finish = async (patch: Omit<JobRunPatch, 'finishedAt' | 'durationMs'>): Promise<void> => {
    if (!runId) return;
    const finishedAt = now();
    try {
      await store.finishRun(runId, {
        ...patch,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      });
    } catch (error) {
      logger.warning('could not stamp a JobRun row; the run itself is unaffected', {
        jobId,
        runId,
        attempt,
        error: errorMessage(error),
      });
    }
  };

  try {
    const summary = sanitizeSummary(await fn());
    await finish({ ok: true, error: null, summary });
    return summary;
  } catch (error) {
    await finish({ ok: false, error: errorMessage(error), summary: null });
    throw error;
  }
}

// ── pruneJobRuns ────────────────────────────────────────────────────────────

export const DEFAULT_RUN_RETENTION_DAYS = 90;

/**
 * Drop ledger rows older than the retention window.
 *
 * One row per attempt per job, twelve schedules and a worker that retries means
 * this table grows monotonically and faster than anything else in the schema.
 * Ninety days is the same window the rest of the operational data uses and is
 * long enough to answer "was this broken last quarter?".
 *
 * Registered as an ordinary schedule entry by #1676 (`'jobs.pruneRuns'` in
 * `./types`), never as a hand-rolled `setInterval` — a sweep on its own timer is
 * a second scheduler nobody can see or lease.
 *
 * Cut by `startedAt`, not `finishedAt`: a run that never finished has no
 * `finishedAt` at all and would otherwise be the one kind of row the sweep can
 * never remove.
 */
export async function pruneJobRuns(
  retentionDays: number = DEFAULT_RUN_RETENTION_DAYS,
  opts: QueueOptions = {}
): Promise<number> {
  const store = await resolveStore(opts);
  const now = clockOf(opts);
  const days = Math.max(1, Math.trunc(retentionDays));
  return store.deleteRunsStartedBefore(new Date(now().getTime() - days * 24 * 60 * 60_000));
}

// ── An in-memory store, for tests and for local reasoning ───────────────────
//
// Same role as `createMemoryLeaseStore()` in `lease.ts`: the rules above can be
// exercised without MySQL. It is a MODEL of the engine, not a substitute for
// it — the SQL in `./queueStore` is still only proven against a real MySQL 8.
//
// What it does model faithfully is the ONE property the claim query exists for.
// `claimDue()` marks its candidate rows as locked SYNCHRONOUSLY, before its
// first `await`, and skips rows another in-flight claim has already locked.
// That is `SKIP LOCKED` in one sentence, and it is enough to show that two
// interleaved claims cannot both take the same job. The `pause` hook is what
// lets a test interleave them at all.

export interface MemoryQueueStore extends QueueStore {
  jobs: JobRecord[];
  runs: (NewJobRun & { id: string; patch: JobRunPatch | null })[];
}

export interface MemoryQueueOptions {
  /** Awaited inside `claimDue`, after the rows are locked and before the update. */
  pause?: () => Promise<void>;
}

export function createMemoryQueueStore(options: MemoryQueueOptions = {}): MemoryQueueStore {
  const jobs: JobRecord[] = [];
  const runs: (NewJobRun & { id: string; patch: JobRunPatch | null })[] = [];
  const locked = new Set<string>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}_${++seq}`;

  const store: MemoryQueueStore = {
    jobs,
    runs,

    insertJob: async (data) => {
      if (data.idempotencyKey && jobs.some((j) => j.idempotencyKey === data.idempotencyKey)) {
        // Shaped like Prisma's P2002 so the rules above are exercised against
        // the error they will actually meet.
        const error = new Error('Unique constraint failed on the fields: (`idempotencyKey`)') as Error & {
          code?: string;
        };
        error.code = 'P2002';
        throw error;
      }
      const at = new Date();
      const row: JobRecord = {
        id: nextId('job'),
        name: data.name,
        payload: data.payload,
        status: 'PENDING',
        priority: data.priority,
        runAt: data.runAt,
        attempts: 0,
        maxAttempts: data.maxAttempts,
        lastError: null,
        lockedAt: null,
        lockedBy: null,
        idempotencyKey: data.idempotencyKey,
        orgId: data.orgId,
        createdAt: at,
        updatedAt: at,
      };
      jobs.push(row);
      return { ...row };
    },

    findJobByIdempotencyKey: async (key) => {
      const row = jobs.find((j) => j.idempotencyKey === key);
      return row ? { ...row } : null;
    },

    claimDue: async ({ now, limit, workerId }) => {
      // Synchronous section — this is the FOR UPDATE SKIP LOCKED.
      const taken = jobs
        .filter((j) => j.status === 'PENDING' && j.runAt.getTime() <= now.getTime() && !locked.has(j.id))
        .sort((a, b) => b.priority - a.priority || a.runAt.getTime() - b.runAt.getTime())
        .slice(0, limit);
      for (const row of taken) locked.add(row.id);

      try {
        if (options.pause) await options.pause();
        for (const row of taken) {
          row.status = 'RUNNING';
          row.lockedAt = now;
          row.lockedBy = workerId;
          row.updatedAt = now;
        }
        return taken.map((row) => ({ ...row }));
      } finally {
        for (const row of taken) locked.delete(row.id);
      }
    },

    reapExpired: async ({ lockedBefore }) => {
      let moved = 0;
      for (const row of jobs) {
        if (row.status !== 'RUNNING') continue;
        if (!row.lockedAt || row.lockedAt.getTime() >= lockedBefore.getTime()) continue;
        row.status = 'PENDING';
        row.lockedAt = null;
        row.lockedBy = null;
        // `attempts` intentionally untouched.
        moved += 1;
      }
      return moved;
    },

    insertRun: async (row) => {
      const id = nextId('run');
      runs.push({ ...row, id, patch: null });
      return id;
    },

    finishRun: async (runId, patch) => {
      const row = runs.find((r) => r.id === runId);
      if (row) row.patch = patch;
    },

    deleteRunsStartedBefore: async (cutoff) => {
      const keep = runs.filter((r) => r.startedAt.getTime() >= cutoff.getTime());
      const removed = runs.length - keep.length;
      runs.length = 0;
      runs.push(...keep);
      return removed;
    },
  };

  return store;
}
