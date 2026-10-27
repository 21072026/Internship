# 2026-10-27 — emit() and the subscriber registry (#1693, #1697)

- **Check what an issue's dependencies actually shipped.** #1693 says "write the row
  through #1680's `publishEvent`" — #1680 had not landed (no `src/lib/events/publish.ts`).
  The catalogue (#1691), the `DomainEvent` table and the job queue/worker (#1671/#1673)
  had. Built the minimum core on what exists and named the single insert path as the
  thing #1680 replaces, instead of inventing #1680.
- **MySQL JSON columns re-order object keys** (by length, then bytewise). Anything that
  stores a payload and later re-serialises it (a webhook body, a signature) changes bytes
  unless it re-orders. zod's `parse` emits keys in *schema* order, so re-parsing through
  the catalogue entry restores the producers' order — the unit spec simulates MySQL's
  ordering to pin it.
- **The job worker is testable end-to-end without a DB**: `createMemoryQueueStore()` +
  `createJobRegistry()` + `createWorker()` run the real claim → handler → settle loop in a
  `*.unit.spec.ts` (`BASE_URL=http://localhost:9 npx playwright test <spec>`).
- A new `JobTrigger` value needs no schema change (`JobRun.trigger` is `VarChar(16)`); the
  worker falls back to `'schedule'` only for values `isJobTrigger()` does not know.
