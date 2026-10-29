## 2026-10-29 — a retention clock for what an erasure keeps (#2098)

- **`main` can carry a red `check:erasure-coverage`.** #3244 added `RequisitionFit.reason`
  (`@db.Text`) without a decision; the guard runs in CI but the PR merged anyway. Run
  `npm run check:erasure-coverage` on a clean `origin/main` first, so you know which red is yours.
- **ContactPermission has a structural one-writer test.** `scripts/test/contact-permission.test.mjs`
  greps all of `src/` for `.contactPermission.(create|update|delete…)(` outside
  `src/lib/contactPermission.ts`. An erasure stamp or a retention delete written inline fails
  `npm run test:unit`; add an exported op to the writer module instead (`stampContactProofsErased`,
  `deleteExpiredContactProofs`).
- **`e2e/retention-prune.spec.ts` pins the full list of registry keys.** A new
  `BUILT_IN_RETENTION_ENTRIES` entry needs its key added there in the same diff.
- **A legal period in years from year-end does not fit the registry's `defaultDays`.** Give the
  entry a nominal day count for the summary and compute the real cutoff inside `run`
  (`retainedRecordCutoff(now, years)` = 1 Jan of nowYear − years; anchor < cutoff ⇔ expired). The
  unit test cross-checks the SQL form against the date form across year boundaries.
- **Specs that never open a page run without the dev server:** `BASE_URL=http://localhost:1`
  skips Playwright's `webServer`, so a DB-only spec finishes in ~3 s instead of a cold `next dev`.
  The pinned headless shell (`chromium_headless_shell-1248`) is missing here; a symlink to
  `-1243` under `/opt/pw-browsers` is enough.
- **`e2e/candidate-erasure.spec.ts` fails locally on a clean `origin/main` too** (UI timing
  against a cold dev server), so it is not a signal for erasure changes; the DB-level erasure
  specs are.
