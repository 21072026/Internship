## 2026-10-21 — the hiring desk: applicant board, /admin/hiring, document review chain, recruiting analytics, job board and apply flow (#1838, #1874, #1859, #1911, #1830, #1832)

- **A branch stacked on another PR's branch conflicts with `main` once that PR is squash-merged.**
  Every file the base PR added shows up as add/add. Check that the base PR's work commit is in your
  first-parent history (`git log --first-parent`) and that `main`'s copy equals the base branch's
  tip (`git diff <base-tip> origin/main -- <file>` is empty). If both hold, `git checkout --ours`
  is safe for those files, and only shared files (`dictionaries.ts`, `catalog.ts`) need a real
  merge: keep both sides of a hunk unless one side already contains the other.
- **One `node_modules` for several worktrees: symlink it, then keep the symlink out of the commit.**
  `git add -A` with a `node_modules` symlink present produced an empty-looking push. Remove the link
  (or stage paths explicitly) before you add.
- **A stale `next-server` from another worktree answers the e2e run.** Playwright reuses whatever
  is on :3000, so a test hit the wrong branch's code (a 404 where the code said 403). Kill
  `next-server` before every run, and don't use `pkill -f` patterns that also match your own shell.
- **A local test DB shared between branches drifts.** `db push` failed with
  "Cannot drop index … needed in a foreign key constraint" after another branch's schema. Give each
  worktree its own database (`internship_t<issue>`) in its own `.env`.
- **After a container reset there is no MySQL service: `apt-get update && apt-get install
  mariadb-server`, `service mariadb start`, and set a root password for Prisma.** Playwright's
  pinned headless shell (`chromium_headless_shell-1248`) is missing too. Symlink the installed
  1194 build into the expected path, including a `chrome-headless-shell` link to `headless_shell`.
- **Notification keys are global: grep the catalog before naming one.** `application.received`
  already existed. The new mail events became `job_application.*`. Each new notification also needs
  its `notifications.events` string in all three locales, or `test:notification-catalog` fails.
