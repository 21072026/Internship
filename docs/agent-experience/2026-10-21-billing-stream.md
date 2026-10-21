## 2026-10-21: billing stream — /admin/billing, plan-change requests, grants, upgrade prompt (#1739, #1743, #1734, #1745)

- **Worktrees share one `node_modules`, so they share one generated Prisma client.** Running
  `prisma generate` in one worktree and an e2e run in another (on an older `origin/main`) gave
  `P2022` (column missing) 500s in specs that never touched the changed models — and a
  `db push --accept-data-loss` from the older worktree then dropped columns the client expected.
  Before an e2e run: merge `origin/main` into the branch, `prisma generate` **in that worktree**, and
  `db push` from it. A local DB that drifted (e.g. "Cannot drop index … needed in a foreign key
  constraint") is fastest fixed by `DROP DATABASE` + `db push` + `db seed` — it is synthetic.
- **`npm ci` in the main checkout deletes and rebuilds the `node_modules` every worktree links
  to.** Run it only when no worktree is mid-test; new deps on main (e.g. `@visx/*`) show up as
  `TS2307` in `tsc` until it is re-run.
- **The diff check before a push is three-dot:** `git diff --stat origin/main...HEAD`. The
  two-dot form lists every file main changed since the branch point and looks like a foreign
  revert when it is not.
- **`check:openapi` wants an explicit ADMIN guard on every `/api/admin/*` handler.** A
  super-admin-only route that starts with `superAdminWorld()` / `isSuperAdmin()` is classified
  `any-session`; put `if (session.user.role !== 'ADMIN') return 403` first.
- **`/api/org/*` is the tenant-scoped route family** (no `orgId` parameter, org from the
  session); the operator side of the same feature lives under `/api/admin/*` and checks
  `isSuperAdminFor(session, targetOrgId)` — 403 for a tenant admin, 404 for the other world.
- **One-open-row invariants hold with a unique "open key"** (`PlanChangeRequest.openKey` = orgId
  while NEW, NULL once handled), not with read-then-write; retry the upsert once on `P2002`.
- **A new user-facing string with mentor/mentee in it fails the MARKETING leak ratchet** unless
  the namespace is gated (`LEAK_EXEMPT` with gatePage + requireCapability) or it gets a MARKETING
  overlay entry. `check:i18n -- --leaks` names the keys.
- **Two git stashes across a fast-forward merge conflict like a merge**: `git stash pop` after
  `git merge origin/main` leaves `<<<<<<< Updated upstream` markers when both sides inserted a
  block at the same anchor (dictionary blocks before `organizations:`) — keep both sides.
- **On this 4-core container, `next dev` compiles pages too slowly for multi-page specs.** Runs
  of six specs failed with `waitForURL`/`page.goto` timeouts that had nothing to do with the
  change; after `npm run build`, the same specs with `CI=1` (Playwright then starts `npm run
  start`, the gate's own server) passed 15/15 in 47 s. Build first, then `CI=1 npx playwright test …`.
