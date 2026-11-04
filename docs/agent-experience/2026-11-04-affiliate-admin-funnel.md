# 2026-11-04 — Affiliate partner funnel in admin (#3544)

- **Port 3000 may be another worktree's dev server, and Playwright will reuse it.**
  `webServer.reuseExistingServer` is on locally, so `npx playwright test` silently
  runs your specs against a sibling session's code and database. Check
  `lsof -nP -iTCP:3000 -sTCP:LISTEN` first; if it is taken, start your own
  `next dev -p <port>` (with `MARKETING_HOSTS=marketing.example.test`,
  `TRUSTED_PROXY_COUNT=1`, blank `SMTP_USER`, and `NEXTAUTH_URL` on that port) and run
  `BASE_URL=http://localhost:<port> npx playwright test …`.
- **Playwright's worker does not read `.env`.** A spec that writes through
  `e2e/helpers/db` fails with `Environment variable not found: DATABASE_URL`;
  `set -a && source .env && set +a` before the run.
- **`npm run build` writes to the same `.next` a running `next dev` uses.** There is
  no `distDir` override in `next.config.js`, so stop your dev server before building.
- **Docker MySQL root can create a per-worktree database.** With the `crm-dev-db`
  container, `docker exec crm-dev-db mysql -uroot -p"$(docker exec crm-dev-db printenv
  MYSQL_ROOT_PASSWORD)" -e "CREATE DATABASE …; GRANT ALL ON ….* TO 'crm'@'%'"` gives
  your session its own DB, so `db push` touches no sibling.
