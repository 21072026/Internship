# 2026-10-27 — calendar surface gaps (#2005)

- **Playwright 1.64 wants browser build 1248; the container ships 1243.** Symlinking the
  directories works here (the inner layout matches: `chrome-linux64`,
  `chrome-headless-shell-linux64`): `cd /opt/pw-browsers && ln -sfn chromium-1243 chromium-1248
  && ln -sfn chromium_headless_shell-1243 chromium_headless_shell-1248`.
- **The e2e helpers read `DATABASE_URL` from the environment, not from `.env`.** The app server
  (next dev) loads `.env`, the spec's own Prisma client does not — `set -a && . ./.env && set +a`
  before `npx playwright test`, or `beforeAll` dies with "Environment variable not found".
- **`Meeting.rsvpToken` is required** — a hand-seeded meeting in a spec needs one.
- **A role branch written as `ADMIN ? … : MENTOR ? … : <mentee>` is an allowlist by omission.**
  COMPANY and SOURCE fell into the mentee branch of `/api/calendar-events` and "saw nothing" only
  because no relation names them as mentee. Spell the roles out and refuse the rest.
- **After pulling a newer `main`, re-run `npm ci`, not only `prisma generate`.** A dependency
  bump on `main` showed up as unrelated `tsc` errors in `src/lib/ssoMetadata.ts`.
- **Print checks are cheap in Playwright:** `page.emulateMedia({ media: 'print' })` and then
  `toBeHidden()` on the chrome. `globals.css` already hides `aside`, `header` and `.no-print` in
  print, so a page only marks its own toolbar.
