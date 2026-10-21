## 2026-10-20/21 — roster feeds: config, deprovisioning, console; erasure of the run log (#1964 #1966 #1967 #2098; PRs #3033 #3068 #3096 #3105)

- **A squash-merged predecessor makes `git merge origin/main` conflict on every file you touched
  again.** Stacking PR B on PR A's branch, then merging main after A was squashed, conflicted in
  six files whose content was in fact identical. `git rebase --onto origin/main <A's head sha>`
  replayed only B's commit cleanly. This is fine on your own branch before it is pushed. After
  pushing, merge.
- **Re-check main for the thing an issue says "if it has landed, use it".** #1967 said "use
  #1675's scheduler if it landed, else one node-cron waker". It landed (#1676) *while the PR was
  being written*. The merge conflict in `/api/cron/start` was the only hint.
  `e2e/job-scheduler.unit.spec.ts` now fails on any direct `cron.schedule(` call. A new periodic
  job goes in `src/lib/jobs/schedules.ts` as a `queue({...})` entry, plus a `JobPayloadMap` name
  and a `registerJob()` in `src/jobs/index.ts`.
- **Node's `--experimental-strip-types` refuses TS-only syntax in anything
  `scripts/test/*.test.mjs` imports.** A parameter property (`constructor(readonly abort: X)`)
  failed `npm run test:roster-ingest` with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Use a plain field
  plus an assignment. The same applies to enums and namespaces.
- **A filtered table fed by `useEffect` + `fetch` needs a request sequence number in dev.**
  StrictMode double-runs the first effect, so the slower duplicate of the unfiltered request can
  land after the filtered one and overwrite it. The e2e then failed with the row "still there".
  The fix is a `useRef` counter: only the newest response may set state.
- **A local DB that has followed many branches can refuse a main-side `db push`** (here: "Cannot
  drop index `Setting_orgId_key_key`: needed in a foreign key constraint", a re-key on main). CI
  uses a fresh database, so this is not your PR's failure. `DROP DATABASE internship_test; CREATE
  DATABASE internship_test;`, then `db push` and `db seed`. Symptoms in the dev server log look
  like your bug: `The column Setting.programId does not exist`, and sign-in times out on
  `account-menu-button`.
- **`npm ci` in the main checkout is needed when main adds a dependency.** Worktrees symlink its
  `node_modules`. `tsc` failing on `@visx/*` modules was main's new dependency, not your change.
  `git checkout -- package-lock.json` first if an earlier `npm install` dirtied it.
- **A test-only network switch is the established way to let the e2e suite exercise an
  SSRF-guarded fetch.** Follow `AUDIT_DRAIN_ALLOW_INSECURE_RECEIVERS` / `HIBP_ALLOW_INSECURE_STUB`:
  a stub under `e2e/support/`, a webServer entry plus a port constant in `playwright.config.ts`,
  and an env flag that admits exactly `http://127.0.0.1:…`. `ROSTER_FEED_ALLOW_INSECURE_STUB` is
  the roster feed's. An in-process spec calling the runner directly must set the flag on its own
  `process.env`, since the worker does not inherit the app server's env.
- **A column without a foreign key to `User` survives a hard delete.** Ask erasure about every
  new `userId`/address column, not only `@db.Text` ones. `RosterRowResult.userId` and
  `RosterRun.absentKeys` (addresses in JSON) were reachable by neither erasure path until #3105.
  The COVERAGE block in `src/lib/accountErasure.ts` and the sanitize-db header are the two lists
  to update together.
- **The usage limit stops a turn mid-work, and the container may restart meanwhile.** On resume,
  run `service mysql start`, `npx prisma generate`, and `git status` in every worktree first. The
  uncommitted work survived; MySQL did not.
