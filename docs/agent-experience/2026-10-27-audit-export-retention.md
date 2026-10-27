# 2026-10-27 — Audit log CSV export + retention (#1585)

- Issues written before a shared mechanism landed can name the wrong shape. #1585 asked for
  `auditRetentionMonths` + `run(cutoff)`; #1678's registry had since settled on **days**
  settings (`*RetentionDays`, global scope) and `run(ctx)`. Follow the code that exists, note
  the deviation as a "Varsayım" in the PR.
- Adding a global-scope setting moves `GLOBAL_SETTING_KEYS`, which
  `e2e/settings-resolution.unit.spec.ts` pins exactly — update the list in the same diff.
- A viewer and its export must share ONE filter builder (`src/lib/auditQuery.ts`); a copy drifts.
- A sweep that deletes a streamed table has to respect the stream's cursor (`AuditDrain`), and a
  *paused* drain still counts — it self-pauses during the very outage that matters.
- `src/lib/rosterFeedAdmin.ts`'s `csvCell` is the repo's CSV-injection-safe cell; `reports/render.ts`'s
  `toCsv` is not — don't reuse the latter for free-text columns.
