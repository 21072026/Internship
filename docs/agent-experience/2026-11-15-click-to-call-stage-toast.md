## 2026-11-15 — Marketing go-live metrics, click-to-call on the lead page, stage-advance toast (#2578, #3748, #3758, #3761)

- **Before adding a response field, read what the API already returns.** `POST /api/interactions`
  already answered `stageAdvance: { from, to } | null` (#3746) and the interaction form read it.
  The click-to-call question only had to read the same field. The toast + Undo moved into one hook
  (`src/components/useStageAdvanceToast.ts`) that both callers share, so two copies cannot drift.
  Undo reuses `PUT /api/mentorship/[id]`, the path a board drag takes. No new endpoint.
- **Read the toast text right after the click, and don't use the badge as the reference.** The
  first version of the e2e read the stage badge as soon as the toast appeared, then asserted the
  toast contained that label. The badge still showed the *old* stage, because `router.refresh()`
  had not landed yet. The test failed with `expected substring "New lead"`. The fix:
  1. Capture the badge text before the call.
  2. Read the toast text right after "Yes".
  3. Poll the badge until it differs from the captured text, then assert the toast contained the
     new label.
- **`next build` gets OOM-killed without a bigger heap.** The build died with `FATAL ERROR: Reached
  heap limit … SIGABRT`. Build with `NODE_OPTIONS=--max-old-space-size=7168`, the same flag `tsc`
  needs.
- **After merging `origin/main`, run `npm run i18n:scopes` before `tsc`.** A main commit added a
  layout with `<I18nScope scope="admin/hub">`. The scopes file is gitignored and regenerated, so
  until it was regenerated `tsc` failed with `Type '"admin/hub"' is not assignable …`. That was a
  stale file, not a real error.
- **Main moves during a 15-minute gate. Diff the newcomer before re-running everything.** Two
  commits landed while `@smoke` ran.
  - #3760 touched `src/app/sales/leads/[id]/page.tsx`, a file this change also depends on. That
    merge got a rebuild plus the related specs (53).
  - #3757, the admin menu, had no overlap. That merge got tsc, lint, unit tests and the `ci.yml`
    checks only.
- **The container restarts and MariaDB stays down.** A Playwright `webServer` timeout of 120 s was
  the first symptom. Run `mysqladmin ping || service mariadb start` before any e2e run.
- **`check:demo-fidelity` needs a fresh database.** Run `seed:demo` against a throwaway DB: create
  `demo_check`, grant it to the user, `db push`, seed, run the check, drop the DB. The shared e2e
  DB hits duplicate keys.
