## 2026-10-29 — every API route onto the permission layer (#1571, story #1565; #3292 … #3345)

- **Land a ratcheting CI gate first, not last.** The issue said "the gate lands in the last
  PR". With ~25 sessions merging all day, the moving target never stops: `check:authz`
  (#3292) landed on day one as a per-file baseline that only shrinks, and within hours it
  caught new raw `role === 'ADMIN'` sites from three other PRs (#3299, #3318, #3340). Those
  PRs merged with the gate red because `ci.yml`'s check job is not a required check, so every
  slice afterwards had to pin or convert what had appeared on main. Budget for that.
- **A scanner that counts a bare `role` has false positives, and that is fine.** In a route,
  `role === 'ADMIN'` is usually the caller's role. Sometimes it is the *invited* or *mapped*
  role from the body (invite, register, SSO role mappings). Read it as `parsed.data.role`,
  which the gate does not count, or put it in `allowed` with a written reason. Don't weaken
  the pattern.
- **Mixed-role routes need one shared guard, not per-route code.** `requireRoleOrPermission(roles,
  permission)` in `src/lib/authz.ts` replaces `role !== 'ADMIN' && role !== 'MENTOR'`. Its
  `admin` answer replaces every later `session.user.role === 'ADMIN'` branch. A lone admin
  branch asks `can(await actorFromSession(session), permission, undefined, session)` once per
  request. When you add a guard, also teach `check-route-auth.mjs` (GUARDS) and
  `openapi-generate.cjs` (hasSession plus the role list).
- **The per-endpoint permission table is generated, not written.** `openapi-generate.cjs` reads
  the catalogue from `authzRule.ts` and stamps `x-permission` on every operation. `check:openapi`
  fails an `/api/admin` operation that names none. A hand-kept table of ~450 operations
  would be stale within a day.
- **401→403 spec fixes hide behind variables.** `grep "admin/foo" | grep "toBe(401)"` misses
  `const url = …; expect((await x.post(url)).status()).toBe(401)`. The consolidated e2e run
  found three such specs and one OBSERVER test that relied on a role check (affiliate-invite).
  Run the security set plus the touched feature specs on main after a batch of slices.
- **Local e2e in this container:** apt MariaDB (`service mariadb start` again after a worker
  restart, because the restart stops it). Playwright 1.64 wants `chromium_headless_shell-1248`,
  and `/opt/pw-browsers` has 1243, so `ln -sfn chromium_headless_shell-1243
  chromium_headless_shell-1248` (same for `chromium-`). `npm run dev` times out on first-compile
  pages: export `CI=1` and run `npm run build` (~10 min) so Playwright serves `npm run start`.
- **Shared `node_modules` across worktrees means a shared Prisma client.** Symlinking
  `node_modules` into agent worktrees saves the install. But `prisma generate` in one worktree
  rewrites the client for all of them, and a stale client shows up as tsc errors in files you
  never touched (`'MentorOffer' is not assignable to ModelName`). After every `git merge
  origin/main`, run `npx prisma generate` and `node scripts/i18n-scopes.mjs` (gitignored,
  stale after new top-level dirs) before tsc. Never regenerate while a `next build` from
  another checkout is running against a different schema.
- **Baseline conflicts resolve mechanically:** `git checkout --theirs scripts/authz-baseline.json
  && node scripts/check-authz.mjs --shrink`. Then re-add any `allowed` entry your branch
  introduced, because `--theirs` drops it and `--shrink` only lowers `pending`.
- **Verify the PR before merging:** call `pull_request_read` and check `head.ref` and
  `head.sha`, even with `expectedHeadSha`. The orchestrator reported that the MCP merge
  accepted a mismatched SHA for other sessions.
