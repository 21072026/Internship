# 2026-10-21 — authorization model stream (#1567 / #1569 / #1583)

Stream T of the parallel backlog run: the admin tier schema, the permission layer and its
first consumer, the audit trail viewer.

## Lessons

- **Issues written before a later feature can contradict it.** #1567 asked for a
  `SUPER_ADMIN` value on `AdminLevel`, but #1535/#2647 had since made the platform operator
  `User.isSuperAdmin`, read live and per world. Read the code the issue predates before
  copying its schema literally. Omitting an enum value is the reversible choice under
  `db push` (adding one later is additive, removing one is not).
- **"Null denies" vs. create paths.** A nullable tier column plus a deploy backfill leaves
  every admin created *between* deploys (invite, provisioning, role change) without a tier.
  Resolve the effective tier in one pure function (`adminTierFor`) instead of walking every
  ADMIN write path in a schema PR.
- **Stacked PRs + squash merge.** After the base PR squashes, the stacked branch still holds
  the original commit; `git merge origin/main` resolves it cleanly (same content), and
  `git diff --stat origin/main...HEAD` (three dots) confirms only the PR's own files remain.
  Two dots lists main's newer files too and invites a wrong "restore".
- **A worktree with a symlinked `node_modules` goes stale when main adds a dependency**
  (`@visx/*` broke `tsc` with TS2307). Re-run `npm ci` in the checkout that owns
  `node_modules` (detached at `origin/main`) and `npx prisma generate` after every merge
  of main.
- **Playwright 1.64 wants chromium build 1248; the container ships 1194.** The full browser
  symlinks fine (`chromium-1248 → chromium-1194`); the headless shell does not, because the
  directory layout changed: build `chromium_headless_shell-1248/chrome-headless-shell-linux64/`
  as a `cp -as` copy of `…-1194/chrome-linux/` plus a `chrome-headless-shell → headless_shell`
  link and an `INSTALLATION_COMPLETE` marker.
- **Don't `pkill -f` with a pattern your own shell matches** — it kills the tool call
  (exit 144).
- **Running the Lint-job list locally:** extract the `run:` lines of the `checks` job from
  `ci.yml` into a file and loop over it with the job's dummy `DATABASE_URL`; skip
  `check:k6` (needs the k6 binary). Takes ~25 min including `next build`; start it in the
  background and keep working in another worktree — but never run it in a worktree whose
  `next dev` is serving e2e (both use `.next`).
- **A new route guard must be taught to the two static analysers.** `check:route-auth`
  (`scripts/check-route-auth.mjs`, `GUARDS`) and `check:openapi`
  (`scripts/openapi-generate.cjs`, `classifyAuth`) recognise guards by call name; the
  first route on `requirePermission()` failed both until the name was added. Any future
  guard helper needs the same two edits in its first consumer's PR.
- **A long-lived local MySQL drifts.** After merging a main that re-keys a table
  (`Setting`), `db push` fails on the local DB with "Cannot drop index … needed in a
  foreign key constraint" and e2e fails with "column … does not exist". Drop and recreate
  the throwaway local database rather than debugging the push.
