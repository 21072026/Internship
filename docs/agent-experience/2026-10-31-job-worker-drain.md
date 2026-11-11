# 2026-10-31 — A worker poll timeout that was a throughput cap

- **A `expect.poll` on a queued job that times out under the full suite but passes alone is a
  throughput question, not a timeout to raise.** `placement-ledger` waited 30 s for its
  `placement` delivery. The CI log showed `Domain event delivery skipped` warnings exactly two per
  5 s: the worker claimed `concurrency` (2) jobs per tick, and the tick interval (5 s) set the
  pace however fast each job was. A spec that emits a few events late in a 350-test run queues
  behind every earlier spec's deliveries.
- **Grep the server's own log lines in the e2e job for timestamps.** `gh api
  repos/<o>/<r>/actions/jobs/<id>/logs | grep -A40 '<spec>'` shows the `[WebServer]` lines next
  to the failure. Their spacing gives the drain rate without a profiler.
- **A loop that a test's fixed clock drives must use wall time for its own deadline.** The
  worker's `now()` dates the jobs and is a frozen `T0` in `e2e/job-worker.unit.spec.ts`; a drain
  deadline on that clock would never pass.
