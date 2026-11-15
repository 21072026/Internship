# 2026-11-13 — shortening the shared E2E build job (#3710)

- After the smoke scope was narrowed (#3673), `Build app for E2E` (~6 min) became the
  critical path. Read the job's step timings first (`actions_list` → `list_workflow_jobs`
  gives started/completed per step) before guessing where the time goes.
- `next build` runs its own type-check and ESLint pass unless `typescript.ignoreBuildErrors` /
  `eslint.ignoreDuringBuilds` are set; ci.yml already runs both on every commit, so the E2E
  builds now skip them via `NEXT_SKIP_BUILD_CHECKS=1` (env-gated, every other build still checks).
- The E2E build needs no database: the Dockerfile builds against a placeholder `DATABASE_URL`.
  Dropping the MySQL service + `db push` + seed saves ~1 min.
- A local `next build` in this container is a usable timing proxy (4 cores, like a hosted runner).
