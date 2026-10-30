# 2026-10-30 — Custom fields on the profile (#1803, slice 1)

- **`next dev` + `signInAndSettle` (20 s): pre-warm instead of building.** Curl every route the
  spec touches once (`/auth/signin`, the role landing, the page, the API routes) before
  `npx playwright test`; the cold compiles (20–35 s each here) then happen outside the test's
  wait. Cheaper than a 15-minute `next build` for a three-test spec.
- **A worker restart kills background servers and MariaDB.** Commit+push WIP before long
  waits; after a restart check `service mariadb status` and the dev server before re-running.
- **A strict zod body is the cheapest IDOR proof:** `.strict()` turns a smuggled `userId` into
  a 400 the spec can assert, instead of a silently ignored field nobody can test for.
