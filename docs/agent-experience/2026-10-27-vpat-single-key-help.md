## 2026-10-27 — VPAT 2.1.4 / 3.2.6 closed with code + specs (#2864)

- **`playwright test` does not read `.env` for the worker process.** The app server got
  `DATABASE_URL` from `.env`, but `e2e/helpers/db.ts` (`seedUser`) failed with
  `Environment variable not found: DATABASE_URL`. Run with
  `set -a && . ./.env && set +a && npx playwright test …`.
- **Playwright 1.64 wants browser revision 1248; the container ships 1243.** Symlinking
  `/opt/pw-browsers/chromium-1243` → `chromium-1248` and
  `chromium_headless_shell-1243` → `chromium_headless_shell-1248` was enough — no `executablePath`.
- **A VPAT row flips to `Supports` only with a path the test can check.** Writing the spec first
  (`e2e/consistent-help.spec.ts`) and citing it as evidence keeps the row honest; then
  `npm run vpat:evidence` and `node --test scripts/test/vpat.test.mjs`.
