# 2026-10-23 — Klaviyo lead pool, phones, reset (#3162/#3163)

- **A machine import must not pick an owner.** Writing the funnel record at import time put every Klaviyo lead on whichever admin the planner fell back to. `leadOnly` in the import writer (person + account, no relation) plus a claim route is the shape. The "no relation at all" pool filter is deliberate: a closed record means an admin transfer, not a free pickup.
- **Race-safe claim without a unique key:** do a guarded no-op `updateMany` on the lead's row first (InnoDB holds the row lock until commit), then count relations inside the same transaction. The second claimer waits on the lock and sees the first claimer's row.
- **Shared phone numbers are data, not people.** Upstream profiles often carry the sender's own company number. Compare on the last 9 digits and treat a number as non-personal at ≥ 3 distinct people. Keep an admin-editable ignore list on the connection row.
- **Reuse the operator rollback for in-app reset.** `prisma/wipe-integration-source.mjs` exports `buildPlan`/`wipeAccount`. The route needs the confirmed count echoed back, else it returns 409 with a fresh plan, so a plan that changed between preview and click never deletes more than the admin saw.
- **The local `next dev` cold compile (30 s+ on `/sales`) times out e2e requests.** The same tests fail on plain `main` locally, so check that before you chase a regression. CI runs the production build.
- **`stageTrialWindow` is guarded by a writer test.** A new relation-creating path must spread it, otherwise `trial-window-writers` goes red.
