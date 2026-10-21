## 2026-10-21 — the job worker, the leased scheduler, every cron on the queue (#1673 #3037, #1676 #3053, #1677)

- **Run new queue/lease code against real MySQL 8 before pushing, not just the memory store.** The
  in-memory `QueueStore` passed every test; the first `next dev` run against MySQL 8.0.46 found that
  the dead-letter `ActivityLog.detail` overflowed `VARCHAR(191)` (`P2000`, swallowed by
  `logActivity`). `apt-get update && apt-get install -y mysql-server` works in this container.
- **`trigger` is a MySQL reserved word.** `Job.trigger` / `JobRun.trigger` work through Prisma (it
  quotes), but a hand-written `INSERT … (trigger)` is a syntax error — backtick it.
- **Never `pkill -f "next dev"` (or `pgrep -f` with it) in a Bash call.** The pattern matches the
  shell running your own command line and kills it (exit 144). Find the pid with
  `ps -eo pid,args | grep "[n]ext-server"` and kill that.
- **A worktree with a symlinked `node_modules` goes stale the moment main adds a dependency.**
  `tsc` then fails on modules you never touched (`@visx/*` here). Give each worktree its own
  `npm ci`, and re-run it after every `git merge origin/main` that touched `package-lock.json`.
- **The pinned Playwright headless shell can be missing after `npm ci`.** The fix that worked:
  make `/opt/pw-browsers/chromium_headless_shell-<new>/chrome-headless-shell-linux64/` a directory of
  symlinks into the old build's `chrome-linux/`, plus `chrome-headless-shell → headless_shell`.
- **Don't run unit specs in the same checkout while a long e2e run is going.** Both write
  `test-results/`; the e2e run then fails on `ENOENT …/traces/*.trace` for reasons that are not
  the test's.
- **A promise cannot be killed, so a job timeout must be longer than the job.** The worker's 5-min
  default would have failed a long mail sweep while it kept sending, and the retry would run it a
  second time beside it. Ported sweeps register with a 30-min `SWEEP_OPTS`.
- **Count the callers before changing a shared route's default.** `GET /api/cron` is read by about
  80 call sites in about 60 specs. "Enqueue by default" would have rewritten all of them across
  every stream, so the queued path shipped as opt-in `&enqueue=1`.
