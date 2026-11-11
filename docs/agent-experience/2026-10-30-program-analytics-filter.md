# 2026-10-30 — Programme filter on analytics (#1652)

- **A filter that must not change the unfiltered numbers**: make the "all" case add an empty
  object to every `where` (`relationProgramWhere({kind:'all'}) === {}`) and pin that in a unit
  test — then "All programmes reproduces today" is true by construction, not by inspection.
- **Validate a foreign id before computing anything** and answer 404 (not 403), the same shape
  as the other cross-tenant refusals.
- **Running e2e against a hand-started `npm run start`** loses the env `playwright.config.ts`
  gives its own webServer: tenant specs that sign in on the marketing host time out on
  `waitForURL` unless the server was started with `MARKETING_HOSTS=marketing.example.test`.
- **MariaDB in this container can stop between sessions** — a Prisma "can't reach database"
  in every spec is `service mariadb start`, not a code regression.
- A Next.js route file must keep its own guard call (`check:route-auth`), so an "alias" route
  repeats the gate and calls a shared computation in `src/lib/` rather than re-exporting `GET`.
