# 2026-10-29 — company-owned API keys (#2006)

- **Opt-in beats opt-out for a narrowed credential.** The scope check alone would have let a
  company key with `hiring:read` call `POST /api/v1/exports` (which reads the whole org under
  the same scope). The door now refuses a company-bound key unless the route passes
  `{ companyScoped: true }` — a new route is closed to it by default.
- **Replacing a pattern that nests inside another one** (`{ orgId: … }` inside
  `{ relation: { orgId: … } }`) with a string replace hits the inner one first; typecheck
  caught it. Replace the longer pattern first.
- A spec that signs in on a MARKETING host needs `MARKETING_HOSTS`, which only the
  Playwright-started web server sets: a hand-started `npm run dev` with
  `reuseExistingServer` makes those specs time out at sign-in.
- **An e2e spec cannot import server code that uses `@/lib/prisma` at runtime** — the
  Playwright process does not resolve the `@/` alias for it (`Cannot find module
  '@/lib/prisma'`). Drive the behaviour through a real route and poll its effect
  (`expect.poll` over `Job` rows the worker enqueues) instead.
- To tell "mine" from "already red on main", run the same checks in a throwaway
  `git worktree add <dir> origin/main` with `node_modules` symlinked in — no second install.
