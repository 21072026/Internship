# The job worker (#1673)

The queue engine (#1671, `src/lib/jobs/queue.ts`) stores work; the worker runs it.
The mail outbox (`src/lib/mailOutbox.ts`, `docs/mail-queue.md`) is a separate,
specialised drain for `email.send` rows and is not touched by this worker.

## Pieces

| File | Role |
|---|---|
| `src/lib/jobs/workerRule.ts` | Pure rules: backoff (30 s · 2^(n−1), cap 1 h, jitter ×0.75–1.25), dead-letter decision, error text, timeout error |
| `src/lib/jobs/registry.ts` | name → handler (`registerJob`, `getHandler`), per-name `timeoutMs` and `backoff`; `unhandledJobNames()` |
| `src/lib/jobs/worker.ts` | The loop: `createWorker({ store, registry, … })` → `tick()`, `shutdown(graceMs)`, `checkHandlers()` |
| `src/jobs/index.ts` | Every production handler, registered once |
| `src/app/api/jobs/worker/tick/route.ts` | One tick; the process-wide worker; SIGTERM hook; dead-letter → ActivityLog |
| `src/instrumentation.ts` → `startJobWorker()` | POSTs the tick every 5 s on every replica |

## One attempt

1. `reapExpiredLeases()` over the registered names, then `claim()` up to
   `concurrency − in flight` rows, **only of registered names** — a kind nobody
   can run stays PENDING instead of being claimed and stranded.
2. The handler runs under `Promise.race` with its timeout (default 5 min). The
   `AbortSignal` in its context is aborted on timeout and on shutdown; a handler
   that loops over rows should check it.
3. `recordRun()` writes the `JobRun` (before the handler, stamped after) with the
   job's `trigger`.
4. Settle — ONE guarded `updateMany` (`status = 'RUNNING' AND lockedBy = me`):
   `SUCCEEDED`; or `PENDING` with `attempts + 1` and a backed-off `runAt`; or, at
   `attempts >= maxAttempts`, `DEAD_LETTER` + `lastError` + one `job.dead_letter`
   ActivityLog row (which is also the one `logger.error`). A settle that matches
   nothing lost the row to a newer owner and is dropped.

While jobs run, a heartbeat refreshes `lockedAt` every `leaseMs / 3`, so a long
job is not reaped and run twice.

## Delivery is at-least-once — handlers must be idempotent

A container killed mid-job, a late failure after the side effect and an
operator re-run all run a handler again. Each handler states in its comment what
makes the second run harmless (a single-shot stamp, a natural key, an
`idempotencyKey` on the enqueue).

## Shutdown

The tick's request stays open until the jobs it claimed have settled, so Next's
own SIGTERM handling (stop accepting connections, wait for open requests) is
the drain: no new tick arrives, so nothing new is claimed. The route's SIGTERM
hook additionally stops claiming at once and, after 20 s (docker's stop grace in
`infra/deploy-prod.sh` is 25 s), aborts and **releases** whatever still runs —
back to PENDING, `attempts` untouched, due immediately on another replica. What a
SIGKILL still strands is reaped by the clock.

## Switches

- `JOBS_WORKER_ENABLED=0` — no tick (the deploy canary sets it: it shares
  production's database).
- `JOBS_CONCURRENCY` — jobs per process, default 2, max 16.
- Credential: `CRON_SECRET`, else a `JOBS_WORKER_SECRET` minted in-process.

## Adding a handler

1. Add the name and payload type to `JobPayloadMap` / `JOB_NAMES` in
   `src/lib/jobs/types.ts`.
2. `registerJob('<name>', handler, { timeoutMs?, backoff? })` in `src/jobs/`.
3. Say in its comment why a second run is harmless.
4. Who enqueues it on a schedule is the scheduler's registry (#1676).

## The scheduler (#1676, #1677)

Every schedule is a **queue** entry in `src/lib/jobs/schedules.ts`: key, cron
expression, why that cadence, job name, payload and `catchUp`. Every 30 s
(`src/lib/jobs/schedulerRuntime.ts`, started from `/api/cron/start`) the
`'scheduler'` lease holder runs `schedulerTick()` (`src/lib/jobs/scheduler.ts`):
for each schedule, the latest slot after `ScheduleState.lastEnqueuedSlot` is
enqueued with `idempotencyKey = <key>:<slotISO>` and `trigger: 'schedule'`, then
the state advances in one conditional write. `catchUp: 'latest'` enqueues only
the newest missed slot; `'none'` skips any slot more than 2 min old. A schedule
seen for the first time baselines instead of firing.

The bodies are handlers in `src/jobs/` (#1677), grouped by area — `reminders.ts`
(the 09:00 batch), `meetings.ts`, `digests.ts`, `housekeeping.ts`, `platform.ts`.
Each file states why a rerun of each handler is harmless. They call the domain
functions where they live (`emailService`, `newsletterDispatch`, …); `src/jobs/`
imports those, never the reverse.

**The dormancy chain.** The 09:00 sweep `dormancy.sweep` decides who is a dormant
first contact today; `dormancy.checkIn` and `reminders.mentorInteraction` read
that state. So they have no schedule: the sweep enqueues both on success (keyed
on its own job id, so a retried sweep enqueues them once), and a failing sweep
enqueues nothing. The other 09:00 jobs are independent schedules — one failing
no longer skips the rest.

Never call `cron.schedule()` — `e2e/job-scheduler.unit.spec.ts` fails on it. A
new schedule is a `queue({ … })` entry plus a `registerJob()`.

Slots are computed in process local time (`src/lib/jobs/cronSlot.ts`), exactly
like node-cron without a `timezone` option: UTC in the containers.

The lease TTL is 90 s (three ticks). A SIGTERM stops this process from taking
the lease again and releases it, so a rolling deploy hands over in seconds; a
SIGKILLed holder loses it by expiry. `CRON_ENABLED=0` or a missing `CRON_SECRET`
keeps `/api/cron/start` from being called at all, so nothing is scheduled —
the preview/topic safety property is unchanged.

## Manual runs: `GET /api/cron?job=…`

Unchanged by default: the named job runs inline and the response carries its
full result (about 80 e2e call sites read it). Add `&enqueue=1` and the route
instead enqueues the job with `trigger: 'manual'` and answers
`{ queued: true, jobs: [{ name, id }] }` — the worker runs it, with retries and a
`JobRun` an operator can tell apart from a scheduled one. The authorization
(#1575) is the same either way: `OWN_ORG_JOBS` for a tenant ADMIN, scoped to
their org in the payload; everything else a super admin.

## Tenant binding

A job enqueued with an `orgId` runs inside `runWithOrg(job.orgId, …)`; a job
without one runs unbound, as the cron always did (the sweeps scope themselves
per tenant). Per-tenant binding of each sweep is #1561's.
