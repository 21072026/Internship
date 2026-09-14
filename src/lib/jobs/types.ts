// Job names, payload types and run provenance for the queue engine (#1671).
//
// WHY A UNION AND NOT `string`. A queue's payload is the one place where a
// producer and a consumer agree on a shape without ever calling each other:
// `enqueue()` writes JSON, a handler somewhere else reads it back, and nothing
// in between type-checks the hand-off. Naming the jobs in a union and mapping
// each name to its payload type makes that hand-off a compile error instead of
// a runtime `undefined` three weeks later, in a background job nobody is
// watching.
//
// SCOPE / EXTENSION POINT. This union starts with the two housekeeping jobs
// this task itself produces work for. It is deliberately NOT the full list:
//
//   • #1677 replaces the twelve `cron.schedule` callbacks (ten in
//     `src/services/emailService.ts`, two in `src/lib/newsletterDispatch.ts`)
//     with enqueued jobs and adds their names and payloads here.
//   • #1676 owns the schedule REGISTRY that decides which name fires when.
//   • #1673 owns the worker loop that maps a name to a handler.
//
// Adding a name here is additive and safe; inventing those three issues' work
// is not, so this file stops at what #1671 can honestly claim.

/// Where a run came from. Provenance, not status — a failed scheduled run and a
/// failed manual re-run look identical on the row without it, and the
/// operations console (#1607) needs to tell them apart. `'boot'` is a run that
/// fired because the process started, which is the one class of run that can
/// arrive in a burst after a deploy.
export type JobTrigger = 'schedule' | 'manual' | 'boot';

export const JOB_TRIGGERS: readonly JobTrigger[] = ['schedule', 'manual', 'boot'] as const;

export function isJobTrigger(value: unknown): value is JobTrigger {
  return typeof value === 'string' && (JOB_TRIGGERS as readonly string[]).includes(value);
}

/// What a handler may report about the work it did.
///
/// COUNTERS ONLY, and the type says so rather than a comment asking nicely:
/// every value is a number, so there is no shape in which an e-mail address, a
/// mentee's name or the body of a message can be put here. The admin surfaces
/// render this more or less verbatim, which is exactly why it may not hold PII.
/// `sanitizeSummary()` in `./queue` re-checks it at runtime, because a
/// JavaScript caller can hand a TypeScript signature anything at all.
export type JobSummary = Record<string, number>;

/// Name → payload. The payload is stored in `Job.payload` (a MySQL JSON column),
/// so every type here must be JSON-round-trippable: no `Date`, no `undefined`
/// as a meaningful value, no class instances. Pass timestamps as ISO strings.
export interface JobPayloadMap {
  /// Retention sweep over the `JobRun` ledger. Registered as an ordinary
  /// schedule entry by #1676 rather than as a hand-rolled timer; the default
  /// window lives in `pruneJobRuns()`.
  'jobs.pruneRuns': { retentionDays?: number };
  /// The daily dead-letter alert (#1674, `src/lib/jobs/dlqAlert.ts`). It runs
  /// off its own `cron.schedule` today; giving it a name here is what lets
  /// #1676 move it onto the queue without inventing one.
  'jobs.deadLetterAlert': Record<string, never>;
}

export type JobName = keyof JobPayloadMap;

export type JobPayload<N extends JobName = JobName> = JobPayloadMap[N];

export const JOB_NAMES: readonly JobName[] = ['jobs.pruneRuns', 'jobs.deadLetterAlert'] as const;

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && (JOB_NAMES as readonly string[]).includes(value);
}

/// `Job.name` is `@db.VarChar(64)`. Kept here as a constant so a future name
/// that does not fit fails a test rather than a MySQL insert at 03:00.
export const JOB_NAME_MAX_LENGTH = 64;

/// `Job.lockedBy` is `@db.VarChar(64)` — a worker id longer than this would be
/// truncated by MySQL, and a truncated id can collide with another worker's.
export const WORKER_ID_MAX_LENGTH = 64;
