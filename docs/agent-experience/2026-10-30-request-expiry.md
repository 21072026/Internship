## 2026-10-30 — mentorship request expiry and cancellation (#1775)

- **Warm the dev server before judging an e2e run here.** Four specs (two of them untouched by the
  change) "failed" on `apiRequestContext` / `waitForURL` timeouts while `next dev` compiled
  `/portal`, `/mentor/*` and the API routes for the first time. Start `npm run dev` yourself,
  `curl` the routes the specs hit, then run Playwright (it reuses the server): the same 14 tests
  passed. A timeout on the first request of a route is not a regression signal.
- **A daily sweep must not be the only thing that frees a person.** The `already_pending` guard
  reads expiry itself (`isLivePending`), so a request past `expiresAt` stops blocking at that
  instant, not at the next 09:10 tick; the sweep only records it and notifies.
- **A new queued job is four edits:** `JobName` + `JobPayloadMap` (`src/lib/jobs/types.ts`), a
  `queue({…})` in `schedules.ts`, a `registerJob` in `src/jobs/*`, and — to run it from
  `/api/cron` — a `manualJobs.ts` key. `e2e/job-scheduler.unit` and `job-cron-handlers.unit` pin them.
