## 2026-10-21: program journey, admin forms, mentoring agreement (#1852 #1853 #1855 #1800 #1790 #1792)

- **"Lint · Typecheck · Build" is not a required check — auto-merge does not wait for it.**
  #2999 merged with `test:notification-catalog` red and turned main red for every PR (fixed in
  #3010). A new `notifications.events` key needs an entry in `src/lib/notifications/catalog.ts`.
  Before every push, run every `npm run` step of `.github/workflows/ci.yml` locally (a loop over
  `grep -oE "run: npm run [a-z:0-9-]+" ci.yml`), plus `npm run build`, not just tsc/eslint.
- **`check:route-auth` and `check:openapi` only see a guard in the route file itself.** A shared
  `authorizeX()` in `src/lib` that calls `getServerSession` reads as "public". Keep a local
  `requireAdmin()` in each route file and hand the session to the shared helper.
- **Never write a tenant row with `orgId = NULL` when the model has a unique key that includes
  `orgId`.** The deploy's `prisma/backfill-organization.mjs` moves NULL-org rows into the default
  org and fails on the unique key if the default org already has the same row. `seed:demo` runs the
  same backfill and caught it locally. Normalize with `orgId ?? await defaultOrgId()`.
- **Two concurrent "install defaults if missing" `createMany` calls deadlock on MySQL 8 (P2034).**
  Call them sequentially, not in a `Promise.all`, and treat P2034 as "someone else installed it".
- **Worktrees sharing one `node_modules` share one generated Prisma client.** After switching
  worktrees run `npx prisma generate` before `tsc`, or you get phantom "property does not exist"
  errors. When main adds dependencies, `npm install` in the main checkout against main's
  `package.json` and lockfile.
- **A local DB built from an older main can refuse `db push` of the current schema** (for example
  MySQL 1553 when an index that backs an FK is replaced). The deploy runs expand steps first, so
  this is local only: recreate the DB (`DROP DATABASE`/`--force-reset`).
- **`next dev` first-compile is slower than Playwright's 15 s default.** Judge e2e regressions
  with `npm run build` + `CI=1 npx playwright test` (it runs `next start`). Many dev-mode failures
  disappeared there. Two that didn't were real and only `e2e/a11y-scan.spec.ts` caught them: a
  scrollable box without `tabIndex`, and duplicate DOM ids from `<Input>` deriving its id from the
  label (pass `id` explicitly when the same label repeats).
- **`templateToHtml` (`src/lib/renderTemplate.ts`) has no blockquote.** A `> ` line renders
  literally, so a stored markdown body must stick to headings, lists and `**bold**`.
- **Squash-merged stacked PRs give add/add conflicts** when the next branch merges main. The
  branch's own copy is the superset, so take `--ours` for files only you touch. For the shared
  files (`dictionaries.ts`, `check-i18n.ts`, `schema.prisma`), union the hunks. Afterwards check
  `git diff --stat origin/main...HEAD` (three dots).
