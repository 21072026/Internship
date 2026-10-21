## 2026-10-21 — matching engine: rule sets, scorer, admin editor (#1781 #3045, #1783 #3056)

- **Worktrees sharing one `node_modules` share one generated Prisma client.** Several branches
  with different schemas in `git worktree`s, all symlinked to the main checkout's
  `node_modules`, fight over `node_modules/.prisma`: `npx prisma generate` in one worktree breaks
  `tsc`/`next build` in another with "property does not exist on PrismaClient". Run the CI list for
  one worktree at a time and `npx prisma generate` in that worktree right before it. The shared
  `node_modules` must also match the NEWEST branch's lockfile — after merging `origin/main` into a
  branch, `@visx/*` went missing until the main checkout was moved to `origin/main` and `npm ci`'d.
- **A container restart can wipe `node_modules` and stop MySQL without telling you.** An empty
  `node_modules` (and `npx` then offering to install `prisma@8`) or `mysqladmin: connect … failed`
  means a restart: `service mysql start`, `npm ci` (not `npm install` — it rewrote
  `package-lock.json` once), `npx prisma generate`. A stale `.next` after that gave
  "Module not found: next/dist/server/…" on build — `rm -rf .next` fixes it.
- **`pkill -f <pattern>` kills your own shell when the pattern is also in the command line.**
  `pkill -f scratchpad/ci-local; …` exited 144 and took the rest of the command with it. Kill by PID
  or with a pattern that does not occur in the invoking command.
- **A cold `next dev` compiles each route on first hit; a long e2e spec needs `test.setTimeout`.**
  A spec touching six routes and a page timed out at the default 60s locally although every
  assertion was right; `test.setTimeout(180_000)` plus a 45s first visibility wait fixed it. CI runs
  `npm run start`, so it is a local-only cost — but the spec must survive both.
- **Playwright 1.64 wants `chromium_headless_shell-1248`; the container ships 1194.** Make
  `/opt/pw-browsers/chromium_headless_shell-1248/chrome-headless-shell-linux64/` and symlink
  `chrome-headless-shell` → `…-1194/chrome-linux/headless_shell` (plus the sibling files and the two
  marker files). A directory-level symlink is not enough: the layout differs.
- **Check open PRs for the code you are about to replace, not only the issue number.** #3031
  (another stream) rewrote the mentor-suggest ranking while #1787 was being written against the
  old one; the fix was to make the engine's `skills` dimension call that PR's `skillOverlap()`
  rather than keep a second skill scorer.
