## 2026-10-27 — /admin/operations console (#1607)

- **Playwright revision drift in the container:** `@playwright/test` 1.64.1 wants
  `chromium-1248`, the image has `chromium-1243`. `ln -sfn chromium-1243 chromium-1248` (and the
  same for `chromium_headless_shell-*`) under `/opt/pw-browsers` was enough — no download.
- **`.env` is not read by the spec process for Prisma:** the app server gets it through Next,
  but the spec's own `prisma` client fails in `afterAll` with "Environment variable not found:
  DATABASE_URL". Run with `set -a && . ./.env && set +a && npx playwright test …`.
- **Reuse an existing scope rule by exporting its WHERE builder.** The mail queue's
  `scopeWhere()` was private; exporting it as `queueScopeWhere()` let the console read `Job`/
  `JobRun` under exactly the same operator rule instead of a lookalike copy.
- **A new `superAdminOnly` nav link breaks `scripts/test/nav-capabilities.test.mjs`** — it pins
  the list of such links. A new admin nav key also needs an icon in `apps/mobile/src/lib/menu.ts`.
- **An org-scoped viewer cannot judge an absence.** The default-org ADMIN does not see the
  org-less platform runs, so "no run since the slot" is only an alarm where every run is visible
  (`runsVisible`); otherwise every platform schedule would alarm for them forever.
