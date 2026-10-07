# 2026-10-07 — run every CI check, rebasing after a squash, one DB for many worktrees

- **Run every `check:*` that `ci.yml` runs, not the handful you remember.**
  `npm run check:locale-dates` failed a PR that was green on tsc, lint, i18n,
  unit and e2e: a `n.toLocaleString()` with no locale. One loop covers all of
  them: `grep -oE "npm run (check|test)[:a-z0-9-]*" .github/workflows/ci.yml | sort -u`
  then run each and print only the failures. Pass the app locale
  (`useLocale()`) to every `toLocale*` call, numbers included.
- **CodeQL reads test files too.** An unanchored URL regex in a unit test
  (`/linkedin\.com/`) was a "high" alert that kept the PR red; assert with
  `includes()` instead. In a page, a `<select>` value interpolated into an
  `href` is "DOM text reinterpreted as HTML": validate it against the expected
  shape and `encodeURIComponent` it before it reaches a URL.
- **A PR stacked on your own PR, after the base squash-merges:** a plain
  `git rebase origin/main` replays the base's commits and conflicts with their
  squashed copy. Use `git rebase --onto origin/main <last-commit-of-the-base-branch>`
  so only your own commits move, then `--force-with-lease` (your branch).
  Don't enable auto-merge on the stacked PR until the base has merged — it would
  carry the base's diff in with it.
- **All worktrees share one local MariaDB and one generated Prisma client**
  (`node_modules` is a symlink). `prisma db push --accept-data-loss` from a
  worktree whose schema lacks a column another branch added DROPS that column;
  `prisma generate` in one worktree changes the client every other worktree
  compiles against. After switching worktrees run `npx prisma generate && npx
  prisma db push --accept-data-loss --skip-generate` before building or testing.
- **`--grep @smoke` runs a tagged test alone**, so a serial file's earlier
  tests have not set anything up for it (see the companion note from the same
  day). The e2e for a page behind a profile flag needs the flag the real flow
  stamps: the portal only shows the CV tools when `User.cvUrl` is set, which a
  `cvFile.create` alone does not do.
