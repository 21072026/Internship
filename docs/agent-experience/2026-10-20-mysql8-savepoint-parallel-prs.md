## 2026-10-20: MySQL 8 vs MariaDB, parallel PRs from worktrees (#2988, #2989, #2858, #1854)

- **Install the CI's real database before you trust a local green on a raw query.** Prisma 5
  sends every `$executeRawUnsafe` / `$queryRaw` over MySQL's prepared-statement protocol.
  MySQL 8 refuses `SAVEPOINT`, `ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT` there
  (error 1295). MariaDB accepts them, so the account-event dry run (#2966) passed in a
  MariaDB-backed container and was red on the e2e-full's `mysql:8.0` service for days.
  `apt-get install mysql-server-8.0` on this Ubuntu 24.04 image gives **8.0.46**, the CI
  version. Start it with `service mysql start`, then
  `ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'root'`, and use the
  e2e workflow's env (`DATABASE_URL=mysql://root:root@127.0.0.1:3306/internship_test`,
  `SEED_ADMIN_*`). There is no way to send a text-protocol statement through Prisma 5, so
  nested units join the caller's transaction without a savepoint (`src/lib/dbHandle.ts`).
- **Playwright 1.64 wants chromium build 1248, and the image ships 1194 in a different
  layout.** Symlinking the version directory is not enough for the headless shell: 1.64 looks
  for `chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`,
  while 1194 has `chrome-linux/headless_shell`. Make a real `chromium_headless_shell-1248`
  directory, symlink its `chrome-headless-shell-linux64` to the 1194 `chrome-linux`, add a
  `chrome-headless-shell` → `headless_shell` link inside it, and touch
  `INSTALLATION_COMPLETE`. Do the same for `chromium-1248/chrome-linux64`.
- **Run parallel PRs from `git worktree`s, never by switching the main checkout.** A background
  review workflow reads `/home/user/Internship` and `git show HEAD`. Switching that checkout's
  branch mid-review hands its agents the wrong code. Use
  `git worktree add -b <branch> /home/user/wt-<n> origin/main` per PR, and symlink
  `node_modules` from the main checkout (`ln -s /home/user/Internship/node_modules`). Remove
  the link before `git add -A`. One `next dev`/`next start` on port 3000 at a time, so run the
  e2e suites one after another.
- **`list_pull_requests` with a `fields` filter reports `merged: false` for merged PRs.** Use
  `pull_request_read` (method `get`) or `git log origin/main` before you conclude a PR was
  closed unmerged.
- **The daily backup cron runs as root, the freshness check as the runner user.** A 0600 dump
  owned by root reads as "too small: B; not a valid gzip stream" (#2989). `backup-db.sh` now
  hands its dump to the backup directory's owner. The cron runs an installed *copy*, so
  the server needs `sudo install … /usr/local/bin/internship-backup-db` after any change.
- **A CSS colour transition makes a single computed-style read flaky.** Right after
  `emulateMedia(...)` flips a media query, an element with `transition-colors` reports the
  colour it is transitioning *from*. Poll with `expect.poll`
  (`e2e/a11y-media-preferences.spec.ts`).
