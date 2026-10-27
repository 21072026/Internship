# 2026-10-27 — Usage tab on /admin/billing (#1763)

- "No live scan on the request path" + a metric with no ledger row (companies, programmes, AI
  calls, broadcast recipients) → add it as a COMPUTED `UsageMetric` the nightly rollup writes,
  recomputed from its source ledger with the gate's own counting rule. Don't count in the route.
  `scripts/test/metering.test.mjs` pins `COMPUTED_METRICS` exactly — update it in the same diff.
- `PlanLimits` semantics: `null` = unlimited, `0` = not part of the plan. Both must be distinct UI
  states, and neither may read as "over".
- A container restart between tasks kills the apt MariaDB (`service mariadb start` again) and a
  fresh `origin/main` may need `npm ci` + `prisma generate` + `db push` before `tsc` is clean.
- First visit of a new client tab under `next dev` compiles on demand: give the first UI assertion
  a 20s timeout or it fails on the skeleton.
