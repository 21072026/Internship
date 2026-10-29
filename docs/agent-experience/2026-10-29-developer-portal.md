## 2026-10-29 — developer portal and sandbox key (#1992)

- **A page can render a route's own output.** `/developers` imports `GET` from
  `src/app/api/v1/openapi.json/route.ts` and calls it with a synthetic `Request`. That keeps
  the page and the JSON from ever describing different APIs, and it leaves the spec in the route
  file, which `check:api-key-routes` and `check:openapi` read as **text**. Moving the spec into a
  lib module would have blinded both. A route file may not export anything else (Next rejects
  extra exports), so "export a builder from the route" is not an option.
- **Gitignored generated files go stale across branch switches.** After a merge from `main`,
  tsc failed on `I18nScope scope="…"` for directories this branch never touched. The cause was
  `src/i18n/scopes.generated.ts`, which is gitignored and was out of date. Run
  `npm run i18n:scopes` (and `npx prisma generate`) after every merge, before tsc.
- **Main moves under you while e2e runs.** Merge `origin/main`, push and merge in one go once the
  checks are green. The first merge attempt here got `405 merge conflicts` because a sibling
  had edited the `featureCatalog` line next to mine in the meantime.
- **A demo-only credential needs two independent facts.** `DEMO_MODE=true` AND a database
  name ending in `_demo` (the same guard `prisma/reset-demo.mjs` uses). A flag set by mistake
  on a real deployment then still cannot mint a key against real tenant data.
