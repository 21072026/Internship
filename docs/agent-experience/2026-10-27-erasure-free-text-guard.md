## 2026-10-27 — erasure missed ten free-text columns added after #2106 (#2098)

- **A rule in a comment drifts; put it in CI.** The `COVERAGE` block said "a new `@db.Text` column
  about a person belongs in the sweep", and ten such columns shipped without it in eight weeks.
  `scripts/check-erasure-coverage.mjs` now lists every Text column with a decision. When it fails
  on your new column, decide — don't paste `ERASED` without adding the sweep: the guard checks that
  an erasure module touches `prisma.<model>.` and names the column (or deletes the rows).
- **Anonymise keeps the `User` row, so `onDelete: Cascade` protects nothing there.** Every
  user-keyed table (devices, OAuth grants, personal templates) survives anonymise unless swept by
  hand. And `SetNull` relations (`SurveyResponse.respondentId`) leak on a **hard** delete too —
  scrub before the delete, while the link still exists.
- **Address-keyed rows need `erasureScoped()`** (`companyContactErasure.ts`) — never a bare
  `{ email }` match, or a second world's record under the same address is erased too.
- **Local Playwright:** the pinned headless shell (`-1248`) was missing; `ln -sfn
  chromium_headless_shell-1243 chromium_headless_shell-1248` (and the same for `chromium-*`) in
  `/opt/pw-browsers` fixed it. `e2e/candidate-erasure.spec.ts` fails locally on `main` as well
  (UI flow), so it is not a signal for erasure-library changes.
