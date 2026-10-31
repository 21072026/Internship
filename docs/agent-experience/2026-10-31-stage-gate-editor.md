# 2026-10-31 — Stage gate editor (#1590)

- **Never merge `main` or run `prisma generate` while a local e2e run is going.**
  The test process's Prisma client changed under it and the DB had not been
  pushed: 76 smoke tests failed on "column does not exist". Re-push the DB and
  restart the run after every merge.
- **A hand-started `next start` is not the e2e server.** It lacks
  `MARKETING_HOSTS`, the mock ports and the test switches. `CI=1 npx playwright
  test …` (after `npm run build`) starts the servers the config declares.
- **`check:demo-fidelity` counts the local DB.** The demo seeder is idempotent
  and skips an already seeded org, so a DB that e2e cleanup emptied reads FAIL.
  Check it against a fresh database instead.
- **Issue text can be stale.** #1590 said the stage editor was the last
  un-translated admin page; it had been translated meanwhile. Verify before
  planning work around a claim.
- **Read a response body once.** When a caller may still need the body after a
  shared helper reads it, pass `res.clone()` to the helper.
