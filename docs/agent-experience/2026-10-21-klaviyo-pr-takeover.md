## 2026-10-21 — taking over a stalled PR: the Klaviyo pull connector (#2985, #2986)

- **A "merge main" commit can carry a tree that reverts main.** The Copilot agent's "fix the
  merge conflicts" commit on #2986 named main as a parent, but its tree undid main in ~100 files
  outside the PR. A squash of that PR would have reverted other streams' work. Check with
  `git diff --stat origin/main...HEAD` (three dots): it must list only the PR's own files.
  To repair it without a force-push, merge main into the last good commit, then record the bad
  commit as an extra parent with that tree:
  `git commit-tree HEAD^{tree} -p HEAD -p <bad>`. Do **not** use `git merge -s ours <bad>`:
  that moves the merge base past the bad commit's main parent, and the next real merge
  silently reverts everything in between.
- **`withinTenant()` cannot filter a model whose `orgId` is required.** Its legacy
  `OR: [{ orgId }, { orgId: null }]` branch is a `PrismaClientValidationError` on a non-null
  column. The page answers 500, but only under an org context. The connector specs passed
  locally, and the a11y smoke scan of `/admin/companies/[id]` caught it in CI. Pin
  `orgId: <parent>.orgId` instead, and run `e2e/a11y-scan.spec.ts` whenever you touch a page
  it visits.
- **A new background timer goes through `scheduleLeased()` and gets a `SCHEDULES` entry**
  (#1676). `e2e/job-scheduler.unit.spec.ts` fails on any direct `cron.schedule()` call, and on
  a `scheduleLeased('<expr>'` literal that is missing from `src/lib/jobs/schedules.ts` or
  differs from it. Keep the expression a literal in the call, not a constant.
- **A long-lived local test DB drifts from main.** `db push` died with
  `Cannot drop index … needed in a foreign key constraint`, and the specs then failed on missing
  columns. CI always starts empty. After a big main merge, run
  `DROP DATABASE; CREATE DATABASE; db push; db seed` before trusting a local e2e red.
- **The container's MySQL dies on every worker restart.** When a local e2e run shows
  `Can't reach database server`, it is that, not the code. Run `service mysql start` first.
- **The pinned Playwright headless shell is missing here (1248 vs the installed 1194).** Linking
  the directory alone is not enough, because the layout differs. Create
  `chromium_headless_shell-1248/chrome-headless-shell-linux64/` and symlink the 1194
  `chrome-linux/*` files into it, plus `headless_shell` as `chrome-headless-shell`.
- **`schema-push-safety.test.mjs` › "the real #2249 commit" fails in this container on plain
  `origin/main` too.** That red in `test:unit` is not your PR's.
