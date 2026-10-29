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
- **`git add -A -- . ':!.env'` exits non-zero when `.env` is gitignored** ("paths are ignored"),
  so a `git add … && git commit …` chain silently never commits. The PR call then fails with
  "No commits between main and …". Use `git add -A` alone (it skips ignored files on its own).
- **After fetching a fresh `origin/main`, run `npx prisma generate` before `tsc`** — sibling PRs
  add columns all day, and a stale client shows as dozens of TS2353 errors in unrelated e2e specs.
- **Time-based UI is testable without waiting: `page.clock.install({ time: Date.now() })` before
  sign-in, then `page.clock.fastForward('11:56:00')`.** The server clock is untouched, so anything
  the server hands back (a fresh session `expires`) is real time — `page.clock.setSystemTime(Date.now())`
  before that round-trip, or the page sees the new expiry as already near (`e2e/session-timeout.spec.ts`).
- **On `/admin/users` the seeded person's name also matches the sidebar account menu**, so
  `getByText(name).first()` passes before the list has loaded (the first `next dev` compile of
  `/api/admin/lockouts` holds the skeleton for >10 s). Wait for a row action instead.
- **`e2e/mobile-layout-audit.spec.ts` "phone width: the admin rows keep the person identifiable"
  fails on main itself** (`/admin/mentors at 360px (tr)`, 2026-10-28) — confirmed with `git stash`;
  don't chase it as your regression.
- **Write the a11y spec before the CSS fix and watch it fail.** The Shift+Tab hit-test walk in
  `e2e/focus-not-obscured.spec.ts` reported `INPUT university at y=0 is entirely covered` before
  `scroll-padding-top` existed — proof the check can see the defect it guards.
- **Giving a button an extra sr-only name changes its accessible name for every `getByRole(..., { name, exact: true })`**:
  the language switcher went from "de" to "de Deutsch" and four specs needed the new name. Grep `e2e/`
  for the old exact name before changing a shared control's text.
- **`account-menu`, `i18n` and `i18n-de` specs fail locally on main** (2026-10-29: two
  `button[aria-haspopup="menu"]`, and a seed-admin sign-in that never lands) — not a regression signal.
