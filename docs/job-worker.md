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
