# 2026-10-27 — stage automation admin API (#1704, 1/2)

- **After `git checkout` of a fresh `origin/main`, `npx prisma generate` before
  `tsc`** — siblings add models all day; a stale client shows up as dozens of
  `Property 'programEvent' does not exist` errors in files you never touched.
- **"Structurally incapable" is cheap to pin**: a unit spec that reads the import
  lines of the simulate module (and of everything the route imports) and asserts the
  engine / action handlers / mailer / notify are absent. Cheaper and more honest than
  counting side effects with mocks.
- A PATCH that accepts "any subset" is safest as *merge with the stored row, then run
  the same full write-time gate* — no second, partial validator to drift.
